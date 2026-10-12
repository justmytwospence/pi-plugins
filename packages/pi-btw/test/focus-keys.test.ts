import { expect, test } from "vitest";
import { BTW_DEFAULT_FOCUS_SHORTCUTS, describeFocusShortcuts, isValidFocusShortcut, matchesBtwFocusShortcut, resolveBtwFocusShortcuts } from "../src/focus-keys.ts";

test("defaults apply when the variable is unset, blank or unusable", () => {
  expect(resolveBtwFocusShortcuts({})).toEqual([...BTW_DEFAULT_FOCUS_SHORTCUTS]);
  expect(resolveBtwFocusShortcuts({ PI_BTW_FOCUS_KEYS: "  " })).toEqual([...BTW_DEFAULT_FOCUS_SHORTCUTS]);
  expect(resolveBtwFocusShortcuts({ PI_BTW_FOCUS_KEYS: "cmd+/, control+x" })).toEqual([...BTW_DEFAULT_FOCUS_SHORTCUTS]);
});

test("valid entries replace the defaults; duplicates, blanks and typos are dropped", () => {
  expect(resolveBtwFocusShortcuts({ PI_BTW_FOCUS_KEYS: "ctrl+/, CTRL+/ ,, ctrl+alt+b, alt+alt+c, f13" })).toEqual(["ctrl+/", "ctrl+alt+b"]);
  expect(isValidFocusShortcut("ctrl+shift+enter")).toBe(true);
  expect(isValidFocusShortcut("super+/")).toBe(true);
  expect(isValidFocusShortcut("ctrl+")).toBe(false);
  expect(isValidFocusShortcut("ctrl+ctrl+a")).toBe(false);
  expect(isValidFocusShortcut("meta+a")).toBe(false);
});

test("labels read naturally and matching uses the resolved list", () => {
  expect(describeFocusShortcuts(["alt+/", "super+/", "ctrl+alt+w"])).toBe("Alt+/, Super+/ or Ctrl+Alt+W");
  expect(describeFocusShortcuts(["ctrl+b"])).toBe("Ctrl+B");
  expect(describeFocusShortcuts([])).toBe("");
  expect(matchesBtwFocusShortcut("\x1b/", ["alt+/"])).toBe(true);
  expect(matchesBtwFocusShortcut("x", ["alt+/"])).toBe(false);
});
