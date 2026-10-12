// Focus-toggle and width-toggle shortcuts for the BTW overlay.
// Origin: pi-btw 0.6.1 extensions/btw.ts (MIT, Dan Bachelder); unchanged behavior.
import { Key, matchesKey, type KeyId } from "@earendil-works/pi-tui";

export const BTW_DEFAULT_FOCUS_SHORTCUTS: readonly KeyId[] = [Key.alt("/"), Key.super("/"), Key.ctrlAlt("w")];
export const BTW_FOCUS_KEYS_ENV = "PI_BTW_FOCUS_KEYS";
const BTW_FOCUS_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
// Mirrors the SpecialKey union in @earendil-works/pi-tui keys.d.ts (lower-cased).
const BTW_FOCUS_SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
// Symbols from the SymbolKey union (letters/digits are matched directly).
const BTW_FOCUS_SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*",
  "(", ")", "_", "+", "|", "~", "{", "}", ":", "<", ">", "?",
]);

/**
 * Resolve the BTW overlay focus-toggle shortcuts.
 *
 * Users whose window manager or terminal claims the default shortcuts can override them by
 * setting PI_BTW_FOCUS_KEYS to a comma-separated list of pi-tui key identifiers
 * (e.g. "ctrl+/,ctrl+alt+b"). Blank, duplicate, or unparseable entries are ignored; if no
 * usable entries remain, the defaults are kept so focus toggling never becomes impossible.
 */
export function resolveBtwFocusShortcuts(env: NodeJS.ProcessEnv = process.env): KeyId[] {
  const raw = env[BTW_FOCUS_KEYS_ENV];
  if (typeof raw !== "string" || raw.trim() === "") {
    return [...BTW_DEFAULT_FOCUS_SHORTCUTS];
  }

  const seen = new Set<string>();
  const shortcuts: KeyId[] = [];
  for (const part of raw.split(",")) {
    const candidate = part.trim().toLowerCase();
    if (!candidate || seen.has(candidate) || !isValidFocusShortcut(candidate)) {
      continue;
    }
    seen.add(candidate);
    shortcuts.push(candidate as KeyId);
  }

  return shortcuts.length > 0 ? shortcuts : [...BTW_DEFAULT_FOCUS_SHORTCUTS];
}

/**
 * Validate a candidate against the pi-tui KeyId grammar: zero or more distinct recognized
 * modifiers followed by exactly one base key (letter, digit, symbol, or named special key).
 * Rejects typos like "cmd+/" or "control+x" and duplicate/empty segments.
 */
export function isValidFocusShortcut(candidate: string): boolean {
  const segments = candidate.split("+");
  const base = segments.pop();
  if (base === undefined || !isValidFocusBaseKey(base)) {
    return false;
  }

  const seen = new Set<string>();
  for (const segment of segments) {
    if (!BTW_FOCUS_MODIFIERS.has(segment) || seen.has(segment)) {
      return false;
    }
    seen.add(segment);
  }

  return true;
}

function isValidFocusBaseKey(base: string): boolean {
  if (base.length === 1) {
    return /[a-z0-9]/.test(base) || BTW_FOCUS_SYMBOL_KEYS.has(base);
  }
  return BTW_FOCUS_SPECIAL_KEYS.has(base);
}

function formatFocusShortcutLabel(shortcut: KeyId): string {
  return shortcut
    .split("+")
    .map((segment) => {
      switch (segment) {
        case "ctrl":
          return "Ctrl";
        case "alt":
          return "Alt";
        case "shift":
          return "Shift";
        case "super":
          return "Super";
        default:
          return segment.length === 1 ? segment.toUpperCase() : segment;
      }
    })
    .join("+");
}

export function describeFocusShortcuts(shortcuts: readonly KeyId[]): string {
  const labels = shortcuts.map(formatFocusShortcutLabel);
  if (labels.length <= 1) {
    return labels[0] ?? "";
  }
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** Resolved once at load, like the upstream extension; the environment is read when Pi starts. */
export const BTW_FOCUS_SHORTCUTS: readonly KeyId[] = resolveBtwFocusShortcuts();
export const BTW_FOCUS_SHORTCUTS_LABEL = describeFocusShortcuts(BTW_FOCUS_SHORTCUTS);

export function matchesBtwFocusShortcut(data: string, shortcuts: readonly KeyId[] = BTW_FOCUS_SHORTCUTS): boolean {
  return shortcuts.some((shortcut) => matchesKey(data, shortcut));
}

/** Toggles the overlay between framed "window" width and edge-to-edge "full" width. */
export const BTW_WIDTH_TOGGLE_SHORTCUT: KeyId = Key.alt("w");

export function matchesBtwWidthToggle(data: string): boolean {
  return matchesKey(data, BTW_WIDTH_TOGGLE_SHORTCUT);
}
