import { afterEach, beforeEach, expect, test } from "vitest";
import { isKittyProtocolActive, parseKey, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { encodeInput } from "../src/input.ts";

let previousKittyMode: boolean;
beforeEach(() => {
  previousKittyMode = isKittyProtocolActive();
  setKittyProtocolActive(true);
});
afterEach(() => setKittyProtocolActive(previousKittyMode));
const kitty = (codepoint: number, modifiers = 1, event?: number) => `\x1b[${codepoint};${modifiers}${event ? `:${event}` : ""}u`;

test("uses the real Pi key parser for control input, without consuming the panel prefix", () => {
  expect(parseKey(kitty(99, 5))).toBe("ctrl+c");
  expect(parseKey(kitty(100, 5))).toBe("ctrl+d");
  for (const codepoint of [99, 100, 116, 93]) {
    const control = String.fromCharCode(codepoint & 31);
    expect(encodeInput(kitty(codepoint, 5), {})).toBe(control);
    expect(encodeInput(control, {})).toBe(control);
  }
});

test.each(["hello", "你好", "日本語 입력", "é e\u0301", "👩🏽‍💻", "text:3u and :3F", "\r", "\n", "\t", "\x00", "\x1b"])("preserves literal text/control input %j", (data) => {
  expect(encodeInput(data, {})).toBe(data);
});

test.each([
  [kitty(97), "a"], [kitty(97, 2), "A"], [kitty(49, 2), "!"],
  [kitty(65), "A"], [kitty(0x4e2d), "中"], [kitty(0x1f642), "🙂"],
  [kitty(32), " "], [kitty(97, 193), "a"],
  ["\x1b[97:196;2u", "Ä"], ["\x1b[61:43;2u", "+"],
  ["\x1b[1092::97;1u", "ф"],
])("decodes Kitty printable input %j", (data, expected) => {
  expect(encodeInput(data as string, {})).toBe(expected);
});

test.each([
  [9, 1, "\t"], [9, 2, "\x1b[Z"], [13, 1, "\r"], [13, 2, "\r"],
  [13, 3, "\x1b\r"], [27, 1, "\x1b"], [127, 1, "\x7f"], [127, 5, "\x08"],
  [120, 3, "\x1bx"], [120, 4, "\x1bX"], [99, 7, "\x1b\x03"],
  [32, 5, "\x00"], [64, 5, "\x00"], [91, 5, "\x1b"], [92, 5, "\x1c"],
  [93, 5, "\x1d"], [94, 5, "\x1e"], [95, 5, "\x1f"], [63, 5, "\x7f"],
])("encodes Kitty special/control/Alt key %i with modifier %i", (codepoint, modifier, expected) => {
  expect(encodeInput(kitty(codepoint, modifier), {})).toBe(expected);
});

test.each([false, true])("normalizes arrows and Home/End for application cursor mode=%s", (applicationCursorKeysMode) => {
  for (const final of ["A", "B", "C", "D", "H", "F"]) {
    const expected = `\x1b${applicationCursorKeysMode ? "O" : "["}${final}`;
    for (const data of [`\x1b[${final}`, `\x1bO${final}`, `\x1b[1;1:2${final}`]) {
      expect(encodeInput(data, { applicationCursorKeysMode })).toBe(expected);
    }
  }
  for (const [data, final] of [["\x1b[1~", "H"], ["\x1b[7~", "H"], ["\x1b[4~", "F"], ["\x1b[8~", "F"]]) {
    expect(encodeInput(data, { applicationCursorKeysMode })).toBe(`\x1b${applicationCursorKeysMode ? "O" : "["}${final}`);
  }
});

test.each([false, true])("preserves cursor/navigation modifiers in application mode=%s", (applicationCursorKeysMode) => {
  for (const modifier of [2, 3, 4, 5, 6, 7, 8]) {
    for (const final of ["A", "B", "C", "D", "H", "F"]) {
      const legacy = `\x1b[1;${modifier}${final}`;
      expect(encodeInput(legacy, { applicationCursorKeysMode })).toBe(legacy);
      expect(encodeInput(`\x1b[1;${modifier}:2${final}`, { applicationCursorKeysMode })).toBe(legacy);
    }
    for (const number of [2, 3, 5, 6]) {
      const legacy = `\x1b[${number};${modifier}~`;
      expect(encodeInput(`\x1b[${number};${modifier}:1~`, { applicationCursorKeysMode })).toBe(legacy);
    }
  }
});

test("forwards legacy function keys and strips Kitty press/repeat annotations", () => {
  for (const final of ["P", "Q", "R", "S"]) {
    expect(encodeInput(`\x1bO${final}`, {})).toBe(`\x1bO${final}`);
    for (const modifier of [2, 5, 8]) {
      const legacy = `\x1b[1;${modifier}${final}`;
      expect(encodeInput(legacy, {})).toBe(legacy);
      expect(encodeInput(`\x1b[1;${modifier}:2${final}`, {})).toBe(legacy);
      expect(encodeInput(`\x1b[1;${modifier}:3${final}`, {})).toBeUndefined();
    }
  }
  for (const number of [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24]) {
    const legacy = `\x1b[${number}~`;
    expect(encodeInput(legacy, {})).toBe(legacy);
    expect(encodeInput(`\x1b[${number};5:2~`, {})).toBe(`\x1b[${number};5~`);
    expect(encodeInput(`\x1b[${number};5:3~`, {})).toBeUndefined();
  }
});

test.each([kitty(99, 5, 3), kitty(97, 1, 3), "\x1b[1;5:3A", "\x1b[1;1:3H", "\x1b[3;2:3~"])("ignores releases %j", (data) => {
  expect(encodeInput(data, {})).toBeUndefined();
});

test("forwards repeats, modifyOtherKeys, and layout-aware Ctrl mappings without CSI-u", () => {
  expect(encodeInput(kitty(99, 5, 2), {})).toBe("\x03");
  expect(encodeInput("\x1b[27;5;99~", {})).toBe("\x03");
  expect(encodeInput("\x1b[1092::99;5u", {})).toBe("\x03");
  expect(encodeInput("\x1b[61:43;3u", {})).toBe("\x1b="); // Shift not held.
  expect(encodeInput("\x1b[61:43;4u", {})).toBe("\x1b+");
});

test.each([false, true])("handles keypad numeric/application mode=%s", (applicationKeypadMode) => {
  const normal = "0123456789./*-+\r=,";
  const application = "pqrstuvwxynojmkMXl";
  for (let index = 0; index < normal.length; index++) {
    const expected = applicationKeypadMode ? `\x1bO${application[index]}` : normal[index];
    expect(encodeInput(kitty(57399 + index), { applicationKeypadMode })).toBe(expected);
    expect(encodeInput(`\x1bO${application[index]}`, { applicationKeypadMode })).toBe(expected);
  }
  expect(encodeInput(kitty(57419), { applicationCursorKeysMode: true, applicationKeypadMode })).toBe("\x1bOA");
});

test.each([false, true])("only keeps paste wrappers when the child requests them: %s", (bracketedPasteMode) => {
  for (const text of ["", "你好\n🙂\r\t", "MAC:3F literal \x1b[99;5:3u and \x03"]) {
    const wrapped = `\x1b[200~${text}\x1b[201~`;
    expect(encodeInput(wrapped, { bracketedPasteMode })).toBe(bracketedPasteMode ? wrapped : text);
  }
  expect(encodeInput("\x1b[200~incomplete", { bracketedPasteMode })).toBeUndefined();
  expect(encodeInput("\x1b[201~", { bracketedPasteMode })).toBeUndefined();
});

test.each([false, true])("does not change legacy text/Alt/control input when Pi Kitty mode=%s", (active) => {
  setKittyProtocolActive(active);
  for (const data of ["\x1bx", "\x1bX", "\x1bé", "\x1b🙂", "\x1b\x03", "\x1b\r", "\x1b\x1b", "\x1b[Z", "\x08", "\n"]) {
    expect(encodeInput(data, { applicationCursorKeysMode: true })).toBe(data);
  }
});

test.each([
  "", "\x1b[", "\x1bO", "\x1b[999~", "\x1b[broken", "\x1b[99;5u\x1b[100;5u",
  "\x1b[99;nopeu", kitty(99, 9), kitty(99, 17), kitty(99, 33), kitty(0x110000),
  kitty(0xd800), kitty(0xe001), kitty(57364), "\x1b[57364::97;1u", kitty(9, 5),
  "\x1b[1;1:4A", "\x1b[15;5:4~", "\x1b]52;c;ignored\x07",
])("drops unsupported or malformed input rather than leaking packets: %j", (data) => {
  expect(encodeInput(data, {})).toBeUndefined();
});

test("drops modified application-keypad keys with no portable encoding", () => {
  expect(encodeInput(kitty(57400, 5), { applicationKeypadMode: true })).toBeUndefined();
});
