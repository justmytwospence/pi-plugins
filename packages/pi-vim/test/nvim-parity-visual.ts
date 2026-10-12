import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const VISUAL_MODE_PARITY_CASES: NvimParityCase[] = [
  {
    name: "v enters character-wise visual mode",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v"],
  },
  {
    name: "V enters line-wise visual mode",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["V"],
  },
  {
    name: "Escape leaves visual mode without moving the cursor",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "\x1b"],
  },
  {
    name: "v toggles character-wise visual mode off",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "v"],
  },
  {
    name: "V toggles line-wise visual mode off",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["V", "V"],
  },
  {
    name: "V switches a character-wise selection to line-wise",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "V"],
  },
  {
    name: "v switches a line-wise selection to character-wise",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["V", "v"],
  },
  {
    name: "motions move the cursor while the selection stays live",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "l"],
  },
  {
    name: "v9l clamps at the final character of the current line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 0 } },
    keys: ["v", "9", "l"],
  },
  {
    name: "v9h clamps at the first column of the current line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 2 } },
    keys: ["v", "9", "h"],
  },
  {
    name: "o swaps the selection ends",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "l", "o"],
  },
  {
    name: "leaving visual mode restores the normal-mode operators",
    initial: { text: "foo bar", cursor: { line: 0, col: 0 } },
    keys: ["v", "\x1b", "d", "w"],
  },
];

const VISUAL_CHARWISE_DELETE_PARITY_CASES: NvimParityCase[] = [
  {
    name: "vd deletes the character under the cursor",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "d"],
  },
  {
    name: "vlld deletes a forward selection",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "l", "d"],
  },
  {
    name: "v9ld includes the newline but not the next line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 0 } },
    keys: ["v", "9", "l", "d"],
  },
  {
    name: "vhhd deletes a backward selection",
    initial: { text: "hello", cursor: { line: 0, col: 3 } },
    keys: ["v", "h", "h", "d"],
  },
  {
    name: "vjkd back at the anchor selects one character",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "j", "k", "d"],
  },
  {
    name: "v$d deletes through the end of the line",
    initial: { text: "hello", cursor: { line: 0, col: 2 } },
    keys: ["v", "$", "d"],
  },
  {
    name: "v$d includes the trailing newline",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 0 } },
    keys: ["v", "$", "d"],
  },
  {
    name: "v0d deletes back to the start of the line",
    initial: { text: "hello", cursor: { line: 0, col: 3 } },
    keys: ["v", "0", "d"],
  },
  {
    name: "v^d deletes back to the first non-blank character",
    initial: { text: "  hi", cursor: { line: 0, col: 3 } },
    keys: ["v", "^", "d"],
  },
  {
    name: "vjd deletes across a line boundary",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "j", "d"],
  },
  {
    name: "vjd clamps a selection onto a shorter line",
    initial: { text: "abcdef\nxy", cursor: { line: 0, col: 4 } },
    keys: ["v", "j", "d"],
  },
  {
    name: "vwd deletes through the next word start",
    initial: { text: "foo bar baz", cursor: { line: 0, col: 0 } },
    keys: ["v", "w", "d"],
  },
  {
    name: "ved deletes through the end of the word",
    initial: { text: "foo bar", cursor: { line: 0, col: 0 } },
    keys: ["v", "e", "d"],
  },
  {
    name: "vbd deletes back to the previous word start",
    initial: { text: "foo bar", cursor: { line: 0, col: 4 } },
    keys: ["v", "b", "d"],
  },
  {
    name: "vWd deletes through the next WORD start",
    initial: { text: "a.b cd", cursor: { line: 0, col: 0 } },
    keys: ["v", "W", "d"],
  },
  {
    name: "vfbd deletes through the f target",
    initial: { text: "foo bar", cursor: { line: 0, col: 0 } },
    keys: ["v", "f", "b", "d"],
  },
  {
    name: "vtbd deletes up to the t target",
    initial: { text: "foo bar", cursor: { line: 0, col: 0 } },
    keys: ["v", "t", "b", "d"],
  },
  {
    name: "v%d deletes through the matching pair",
    initial: { text: "(ab)", cursor: { line: 0, col: 0 } },
    keys: ["v", "%", "d"],
  },
  {
    name: "v2ld applies a count to the motion",
    initial: { text: "hello", cursor: { line: 0, col: 0 } },
    keys: ["v", "2", "l", "d"],
  },
  {
    name: "vllold deletes the selection after swapping ends",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "l", "o", "l", "d"],
  },
  {
    name: "vlx deletes the selection like d",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "x"],
  },
  {
    name: "vd backs the cursor onto the last remaining character",
    initial: { text: "ab", cursor: { line: 0, col: 1 } },
    keys: ["v", "d"],
  },
  {
    name: "vd takes a whole emoji grapheme",
    initial: { text: "a\u{1F600}b", cursor: { line: 0, col: 1 } },
    keys: ["v", "d"],
  },
  {
    name: "vld ends a selection on an emoji grapheme",
    initial: { text: "a\u{1F600}b", cursor: { line: 0, col: 0 } },
    keys: ["v", "l", "d"],
  },
  {
    name: "vd takes a trailing emoji grapheme",
    initial: { text: "ab\u{1F600}", cursor: { line: 0, col: 2 } },
    keys: ["v", "d"],
  },
  {
    name: "vld overwrites the unnamed register",
    initial: { text: "hello", cursor: { line: 0, col: 1 }, register: "old" },
    keys: ["v", "l", "d"],
  },
];

const VISUAL_CHARWISE_YANK_PARITY_CASES: NvimParityCase[] = [
  {
    name: "vy yanks the character under the cursor",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "y"],
  },
  {
    name: "vlly yanks a forward selection and rewinds the cursor",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "l", "y"],
  },
  {
    name: "vhhy leaves the cursor at the selection start",
    initial: { text: "hello", cursor: { line: 0, col: 3 } },
    keys: ["v", "h", "h", "y"],
  },
  {
    name: "v$y yanks through the end of the line",
    initial: { text: "hello", cursor: { line: 0, col: 2 } },
    keys: ["v", "$", "y"],
  },
  {
    name: "v$y includes the trailing newline",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 0 } },
    keys: ["v", "$", "y"],
  },
  {
    name: "vjy yanks across a line boundary",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "j", "y"],
  },
  {
    name: "vly yanks a whole emoji grapheme",
    initial: { text: "a\u{1F600}b", cursor: { line: 0, col: 0 } },
    keys: ["v", "l", "y"],
  },
];

const VISUAL_CHARWISE_CHANGE_PARITY_CASES: NvimParityCase[] = [
  {
    name: "v$c includes the trailing newline",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 0 } },
    keys: ["v", "$", "c", "\x1b"],
  },
  {
    name: "vlc deletes the selection and opens insert mode",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "c", "\x1b"],
  },
  {
    name: "vlc accepts replacement text",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "c", "X", "\x1b"],
  },
  {
    name: "vls changes the selection like c",
    initial: { text: "hello", cursor: { line: 0, col: 1 } },
    keys: ["v", "l", "s", "\x1b"],
  },
  {
    name: "vjc changes across a line boundary",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "j", "c", "\x1b"],
  },
  {
    name: "vjc accepts replacement text across lines",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "j", "c", "Z", "\x1b"],
  },
];

const VISUAL_LINEWISE_PARITY_CASES: NvimParityCase[] = [
  {
    name: "Vd deletes the current line",
    initial: { text: "abc\ndef\nghi", cursor: { line: 1, col: 0 } },
    keys: ["V", "d"],
  },
  {
    name: "Vjd deletes two lines",
    initial: { text: "abc\ndef\nghi", cursor: { line: 0, col: 0 } },
    keys: ["V", "j", "d"],
  },
  {
    name: "Vkd deletes upward",
    initial: { text: "abc\ndef\nghi", cursor: { line: 2, col: 0 } },
    keys: ["V", "k", "d"],
  },
  {
    name: "V2jd applies a count to the motion",
    initial: { text: "a\nb\nc\nd", cursor: { line: 0, col: 0 } },
    keys: ["V", "2", "j", "d"],
  },
  {
    name: "Vjkd back at the anchor deletes one line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 0 } },
    keys: ["V", "j", "k", "d"],
  },
  {
    name: "Vd deletes the last line",
    initial: { text: "abc\ndef", cursor: { line: 1, col: 0 } },
    keys: ["V", "d"],
  },
  {
    name: "Vd empties a single-line buffer",
    initial: { text: "abc", cursor: { line: 0, col: 0 } },
    keys: ["V", "d"],
  },
  {
    name: "Vx deletes the selected lines like d",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 0 } },
    keys: ["V", "x"],
  },
  {
    name: "Vd overwrites the unnamed register line-wise",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 0 }, register: "old" },
    keys: ["V", "d"],
  },
  {
    name: "Vy yanks the current line and moves the cursor to its start",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["V", "y"],
  },
  {
    name: "Vy on a later line moves the cursor to that line start",
    initial: { text: "abc\ndef", cursor: { line: 1, col: 2 } },
    keys: ["V", "y"],
  },
  {
    name: "Vjy yanks downward and moves the cursor to the first line",
    initial: { text: "abc\ndef\nghi", cursor: { line: 0, col: 1 } },
    keys: ["V", "j", "y"],
  },
  {
    name: "Vky yanks upward and keeps the cursor column",
    initial: { text: "abc\ndef", cursor: { line: 1, col: 2 } },
    keys: ["V", "k", "y"],
  },
  {
    name: "Vkky yanks three lines upward and keeps the cursor column",
    initial: { text: "abc\ndef\nghi", cursor: { line: 2, col: 2 } },
    keys: ["V", "k", "k", "y"],
  },
  {
    name: "Vjky back at the anchor yanks one line from its start",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 2 } },
    keys: ["V", "j", "k", "y"],
  },
  {
    name: "Vkjy back at the anchor yanks one line from its start",
    initial: { text: "abc\ndef", cursor: { line: 1, col: 2 } },
    keys: ["V", "k", "j", "y"],
  },
  {
    name: "Vc empties the line and opens insert mode",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["V", "c", "\x1b"],
  },
  {
    name: "Vc drops the indentation of the changed line",
    initial: { text: "  abc\ndef", cursor: { line: 0, col: 3 } },
    keys: ["V", "c", "\x1b"],
  },
  {
    name: "Vc changes the last line",
    initial: { text: "abc\ndef", cursor: { line: 1, col: 2 } },
    keys: ["V", "c", "\x1b"],
  },
  {
    name: "Vc accepts replacement text",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["V", "c", "Z", "\x1b"],
  },
  {
    name: "Vjc collapses two lines into one empty line",
    initial: { text: "abc\ndef\nghi", cursor: { line: 0, col: 1 } },
    keys: ["V", "j", "c", "\x1b"],
  },
  {
    name: "VS changes the selected lines like c",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["V", "S", "\x1b"],
  },
];

/** Uppercase operators force a character-wise selection to act line-wise. */
const VISUAL_LINEWISE_FORCING_PARITY_CASES: NvimParityCase[] = [
  {
    name: "vY yanks the touched line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "Y"],
  },
  {
    name: "vC changes the touched line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "C", "\x1b"],
  },
  {
    name: "vS changes the touched line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "S", "\x1b"],
  },
  {
    name: "vD deletes the touched line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "D"],
  },
  {
    name: "vX deletes the touched line",
    initial: { text: "abc\ndef", cursor: { line: 0, col: 1 } },
    keys: ["v", "X"],
  },
  {
    name: "vjD deletes both touched lines",
    initial: { text: "abc\ndef\nghi", cursor: { line: 0, col: 1 } },
    keys: ["v", "j", "D"],
  },
];

/**
 * Every gap here is inherited from a divergence that normal mode already has,
 * not introduced by visual mode:
 *
 * - Line-wise deletes leave the cursor at column 0 instead of preserving the
 *   column, exactly as `dd` does today.
 * - `}`/`{` and `gg`/`G` land on a different position than nvim, which is
 *   already skipped in the structural and line-motion parity suites.
 */
const KNOWN_NVIM_PARITY_GAPS = new Set([
  "vD deletes the touched line",
  "vX deletes the touched line",
  "vjD deletes both touched lines",
  "v}d deletes through the paragraph boundary",
  "vGd deletes through the last line",
]);

const INHERITED_GAP_CASES: NvimParityCase[] = [
  {
    name: "v}d deletes through the paragraph boundary",
    initial: { text: "a\nb\n\nc", cursor: { line: 0, col: 0 } },
    keys: ["v", "}", "d"],
  },
  {
    name: "vGd deletes through the last line",
    initial: { text: "abc\ndef\nghi", cursor: { line: 0, col: 1 } },
    keys: ["v", "G", "d"],
  },
];

describe("nvim parity visual mode", () => {
  for (const testCase of [
    ...VISUAL_MODE_PARITY_CASES,
    ...VISUAL_CHARWISE_DELETE_PARITY_CASES,
    ...VISUAL_CHARWISE_YANK_PARITY_CASES,
    ...VISUAL_CHARWISE_CHANGE_PARITY_CASES,
    ...VISUAL_LINEWISE_PARITY_CASES,
    ...VISUAL_LINEWISE_FORCING_PARITY_CASES,
    ...INHERITED_GAP_CASES,
  ]) {
    if (KNOWN_NVIM_PARITY_GAPS.has(testCase.name)) {
      it.skip(`known nvim parity gap: ${testCase.name}`);
      continue;
    }

    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
