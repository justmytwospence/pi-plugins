import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const WORD_TEXT_OBJECT_CASES: NvimParityCase[] = [
  {
    name: "diw deletes the inner word",
    initial: { text: "alpha beta gamma", cursor: { line: 0, col: 7 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "daw deletes the word plus following whitespace",
    initial: { text: "alpha beta gamma", cursor: { line: 0, col: 7 } },
    keys: ["d", "a", "w"],
  },
  {
    name: "diW deletes the inner WORD",
    initial: { text: "cmd --flag=value next", cursor: { line: 0, col: 7 } },
    keys: ["d", "i", "W"],
  },
  {
    name: "daW deletes the WORD plus following whitespace",
    initial: { text: "cmd --flag=value next", cursor: { line: 0, col: 7 } },
    keys: ["d", "a", "W"],
  },
];

// Inner-word class parity: nvim's `iw`/`aw` scan the character class under the
// cursor (word / punctuation / whitespace) rather than skipping ahead to the
// next word. These pin the three-class span across punctuation runs, whitespace
// runs, Unicode words, emoji, and counts. Cases stay mid-line so the operator's
// final cursor column also matches nvim.
const INNER_WORD_CLASS_CASES: NvimParityCase[] = [
  {
    name: "diw on punctuation selects the punctuation run",
    initial: { text: "foo.bar", cursor: { line: 0, col: 3 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "diw on a punctuation run selects the whole run",
    initial: { text: "a -> b", cursor: { line: 0, col: 2 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "daw on a punctuation run adds trailing whitespace",
    initial: { text: "a -> b", cursor: { line: 0, col: 2 } },
    keys: ["d", "a", "w"],
  },
  {
    name: "diw on whitespace selects the whitespace run",
    initial: { text: "foo   bar", cursor: { line: 0, col: 4 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "diw on a single space selects that space",
    initial: { text: "foo bar", cursor: { line: 0, col: 3 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "daw on whitespace adds the following word",
    initial: { text: "foo   bar baz", cursor: { line: 0, col: 3 } },
    keys: ["d", "a", "w"],
  },
  {
    name: "diw keeps an accented word intact",
    initial: { text: "café au lait", cursor: { line: 0, col: 0 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "diw on the accented tail keeps the whole word",
    initial: { text: "café au lait", cursor: { line: 0, col: 3 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "diw keeps a CJK word intact",
    initial: { text: "中文 test", cursor: { line: 0, col: 0 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "diw selects an emoji between letters",
    initial: { text: "a😀b", cursor: { line: 0, col: 1 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "diw keeps an emoji and its variation selector together",
    initial: { text: "x☕️y", cursor: { line: 0, col: 1 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "diw on an astral letter keeps the whole word intact",
    initial: { text: "a\u{10400}b", cursor: { line: 0, col: 0 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "diw from the astral letter itself deletes the whole word",
    initial: { text: "a\u{10400}b", cursor: { line: 0, col: 1 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "2diw spans a word and the following whitespace run",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 1 } },
    keys: ["2", "d", "i", "w"],
  },
  {
    name: "3diw spans word, whitespace, word",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 1 } },
    keys: ["3", "d", "i", "w"],
  },
  {
    name: "2diw from punctuation spans the run and the next word",
    initial: { text: "a.b.c.d", cursor: { line: 0, col: 1 } },
    keys: ["2", "d", "i", "w"],
  },
  {
    name: "ciw on punctuation changes only the punctuation run",
    initial: { text: "foo.bar", cursor: { line: 0, col: 3 } },
    keys: ["c", "i", "w", "X", "\x1b"],
  },
];

// Unsatisfiable counted objects. nvim treats a count that runs out of runs on
// the line as a no-op: the buffer and register are untouched and only the
// cursor drops on the last char of the line where the object motion ran out.
// pi-vim previously deleted the partial span it had collected.
const UNSATISFIABLE_COUNT_CASES: NvimParityCase[] = [
  {
    name: "2diw on the sole word is a no-op",
    initial: { text: "foo", cursor: { line: 0, col: 1 } },
    keys: ["2", "d", "i", "w"],
  },
  {
    name: "3diw spanning past EOL is a no-op",
    initial: { text: "foo", cursor: { line: 0, col: 1 } },
    keys: ["3", "d", "i", "w"],
  },
  {
    name: "4diw past the last word is a no-op",
    initial: { text: "foo bar", cursor: { line: 0, col: 1 } },
    keys: ["4", "d", "i", "w"],
  },
  {
    name: "2daw on the last word is a no-op",
    initial: { text: "foo bar", cursor: { line: 0, col: 5 } },
    keys: ["2", "d", "a", "w"],
  },
];

const QUOTE_TEXT_OBJECT_CASES: NvimParityCase[] = [
  {
    name: 'di" deletes inside double quotes',
    initial: { text: 'say("hello world")', cursor: { line: 0, col: 6 } },
    keys: ["d", "i", '"'],
  },
  {
    name: 'da" deletes around double quotes',
    initial: { text: 'say("hello")', cursor: { line: 0, col: 6 } },
    keys: ["d", "a", '"'],
  },
  {
    name: "di' deletes inside single quotes",
    initial: { text: "call('value')", cursor: { line: 0, col: 7 } },
    keys: ["d", "i", "'"],
  },
  {
    name: "da` deletes around backticks",
    initial: { text: "run(`cmd`)", cursor: { line: 0, col: 6 } },
    keys: ["d", "a", "`"],
  },
];

const DELIMITED_TEXT_OBJECT_CASES: NvimParityCase[] = [
  {
    name: "di( deletes inside parentheses",
    initial: { text: "call(foo, bar) tail", cursor: { line: 0, col: 7 } },
    keys: ["d", "i", "("],
  },
  {
    name: "da( deletes around parentheses",
    initial: { text: "call(foo) tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "a", "("],
  },
  {
    name: "di[ deletes inside brackets",
    initial: { text: "list[one, two] tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "i", "["],
  },
  {
    name: "da[ deletes around brackets",
    initial: { text: "list[one, two] tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "a", "["],
  },
  {
    name: "di{ deletes inside braces",
    initial: { text: "map{key: value} tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "i", "{"],
  },
  {
    name: "da{ deletes around braces",
    initial: { text: "map{key: value} tail", cursor: { line: 0, col: 6 } },
    keys: ["d", "a", "{"],
  },
];

const TEXT_OBJECT_FINAL_STATE_CASES: NvimParityCase[] = [
  ...WORD_TEXT_OBJECT_CASES,
  ...INNER_WORD_CLASS_CASES,
  ...UNSATISFIABLE_COUNT_CASES,
  ...QUOTE_TEXT_OBJECT_CASES,
  ...DELIMITED_TEXT_OBJECT_CASES,
];

describe("nvim parity text objects", () => {
  for (const testCase of TEXT_OBJECT_FINAL_STATE_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});

// After a text-object delete whose range ends at EOL, nvim clamps the cursor
// onto the last remaining grapheme rather than leaving it one past the end.
// pi-vim previously left the cursor on the phantom column, so a following `x`
// no-oped instead of deleting.
const EOL_DELETION_CURSOR_CASES: NvimParityCase[] = [
  {
    name: "diw on trailing punctuation clamps the cursor back",
    initial: { text: "foo.", cursor: { line: 0, col: 3 } },
    keys: ["d", "i", "w"],
  },
  {
    name: "x after a trailing-punctuation diw deletes the last char",
    initial: { text: "foo.", cursor: { line: 0, col: 3 } },
    keys: ["d", "i", "w", "x"],
  },
  {
    name: "daw on the trailing word clamps the cursor back",
    initial: { text: "foo bar", cursor: { line: 0, col: 5 } },
    keys: ["d", "a", "w"],
  },
  {
    name: "diw on trailing whitespace clamps the cursor back",
    initial: { text: "foo   ", cursor: { line: 0, col: 4 } },
    keys: ["d", "i", "w"],
  },
];

describe("nvim parity text object cursor after EOL deletion", () => {
  for (const testCase of EOL_DELETION_CURSOR_CASES) {
    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
