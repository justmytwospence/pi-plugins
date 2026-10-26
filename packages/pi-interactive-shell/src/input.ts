import { decodeKittyPrintable, isKeyRelease, matchesKey, parseKey } from "@earendil-works/pi-tui";

type Modes = {
  applicationCursorKeysMode?: boolean;
  bracketedPasteMode?: boolean;
  applicationKeypadMode?: boolean;
};

const ESC = "\x1b";
const CSI = `${ESC}[`;
const PASTE_START = `${CSI}200~`;
const PASTE_END = `${CSI}201~`;
const CURSOR: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F", clear: "E" };
const TILDE: Record<string, number> = {
  insert: 2, delete: 3, pageUp: 5, pageDown: 6,
  f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
};
const FUNCTION: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };
const KEYPAD_NORMAL = "0123456789./*-+\r=,";
const KEYPAD_APPLICATION = "pqrstuvwxynojmkMXl";
const SHIFTED: Record<string, string> = Object.fromEntries(
  [..."`1234567890-=[]\\;',./"].map((key, index) => [key, [..."~!@#$%^&*()_+{}|:\"<>?"][index]]),
);

function cursor(key: string, application: boolean): string | undefined {
  const final = CURSOR[key];
  return final === undefined ? undefined : `${ESC}${application ? "O" : "["}${final}`;
}

function controlCharacter(key: string): string | undefined {
  if (/^[a-z]$/i.test(key)) return String.fromCharCode(key.toUpperCase().charCodeAt(0) & 31);
  if (" @`2".includes(key)) return "\x00";
  if ("[{3".includes(key)) return ESC;
  if ("\\|4".includes(key)) return "\x1c";
  if ("]}5".includes(key)) return "\x1d";
  if ("^~6".includes(key)) return "\x1e";
  if ("_/-7".includes(key)) return "\x1f";
  if ("?8".includes(key)) return "\x7f";
  return undefined;
}

function encodeKey(id: string, modes: Modes, keypad = -1): string | undefined {
  let modifier = 0;
  // These are Pi's parsed identifiers, not a second terminal protocol parser. Do not split
  // on every '+': '+' itself is a valid key (including identifiers such as 'alt++').
  for (;;) {
    const prefix = /^(shift|alt|ctrl|super)\+/.exec(id);
    if (!prefix) break;
    modifier |= { shift: 1, alt: 2, ctrl: 4, super: 8 }[prefix[1]]!;
    id = id.slice(prefix[0].length);
  }
  if (modifier & 8) return undefined; // No portable legacy equivalent for Super.
  if (keypad >= 0 && modes.applicationKeypadMode) {
    // Modified DECKPAM keys have no portable legacy encoding.
    return modifier === 0 ? `${ESC}O${KEYPAD_APPLICATION[keypad]}` : undefined;
  }
  if (CURSOR[id] !== undefined) {
    return modifier ? `${CSI}1;${modifier + 1}${CURSOR[id]}` : cursor(id, !!modes.applicationCursorKeysMode);
  }
  if (FUNCTION[id] !== undefined) {
    return modifier ? `${CSI}1;${modifier + 1}${FUNCTION[id]}` : `${ESC}O${FUNCTION[id]}`;
  }
  if (TILDE[id] !== undefined) return `${CSI}${TILDE[id]}${modifier ? `;${modifier + 1}` : ""}~`;

  const alt = modifier & 2 ? ESC : "";
  const ctrl = !!(modifier & 4);
  const shift = !!(modifier & 1);
  if (id === "tab") return ctrl ? undefined : `${alt}${shift ? `${CSI}Z` : "\t"}`;
  if (id === "enter") return ctrl ? undefined : `${alt}\r`; // Legacy Enter cannot report Shift.
  if (id === "backspace") return `${alt}${ctrl ? "\x08" : "\x7f"}`;
  if (id === "escape") return ctrl || shift ? undefined : `${alt}${ESC}`;
  if (id === "space") id = " ";
  if (id.length !== 1) return undefined;
  const text = ctrl ? controlCharacter(id) : shift ? (SHIFTED[id] ?? id.toUpperCase()) : id;
  return text === undefined ? undefined : alt + text;
}

/**
 * Encode one complete Pi input event (or a rewrapped paste), not an arbitrary byte stream.
 * Unsupported keys are dropped rather than forwarding Kitty packets to a legacy child.
 * The panel owns its command prefix; even Ctrl+] is ordinary PTY input here.
 */
export function encodeInput(data: string, modes: Modes): string | undefined {
  if (data.startsWith(PASTE_START)) {
    if (!data.endsWith(PASTE_END)) return undefined;
    // Paste contents are opaque text, even when they resemble key-release packets.
    return modes.bracketedPasteMode ? data : data.slice(PASTE_START.length, -PASTE_END.length);
  }
  if (!data) return undefined;
  if (!data.includes(ESC) || data === ESC) return data;
  if (isKeyRelease(data)) return undefined;

  // Pi treats unknown event types as presses. Do not accidentally send one to the child.
  const eventType = /;\d+:(\d+)(?=[uABCDHFP-S~]$)/.exec(data)?.[1];
  if (eventType !== undefined && eventType !== "1" && eventType !== "2") return undefined;
  // Pi 1.2's matchesKey knows the alternate Home/End sequences that parseKey omits.
  const id = parseKey(data) ?? (matchesKey(data, "home") ? "home" : matchesKey(data, "end") ? "end" : undefined);
  const csiU = data.startsWith(CSI) && data.endsWith("u");
  // Pi normalizes numpad keys to ordinary keys. Retain only their physical identity for
  // DECKPAM; Pi still owns all parsing of modifiers, alternate layouts and events.
  const codepoint = csiU ? Number(/^\x1b\[(\d+)/.exec(data)?.[1]) : undefined;
  if (codepoint !== undefined && (!Number.isSafeInteger(codepoint) || codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff))) return undefined;
  const keypad = codepoint !== undefined && codepoint >= 57399 && codepoint <= 57416 ? codepoint - 57399 : -1;
  // Do not turn unrecognized Kitty functional keys into private-use printable characters.
  if (codepoint !== undefined && codepoint >= 0xe000 && codepoint <= 0xf8ff && keypad < 0 && !(codepoint >= 57417 && codepoint <= 57426)) return undefined;
  if (keypad >= 0 && modes.applicationKeypadMode) return id ? encodeKey(id, modes, keypad) : undefined;

  // Legacy SS3 keypad input also needs mode translation; these exact sequences contain
  // no modifiers or events and do not require another key parser.
  if (data.startsWith(`${ESC}O`) && data.length === 3) {
    const index = KEYPAD_APPLICATION.indexOf(data[2]);
    if (index >= 0) return modes.applicationKeypadMode ? data : KEYPAD_NORMAL[index];
  }

  const event = /:[12](?=[ABCDHFP-S~]$)/;
  const extended = csiU || data.startsWith(`${CSI}27;`) || event.test(data);
  if (id && !extended) {
    // Leave compatible VT/Alt encodings intact, except keys affected by DECCKM.
    return cursor(id, !!modes.applicationCursorKeysMode) ?? data;
  }
  // Pi's parser does not identify modified F1-F12 in this version. They already have
  // legacy xterm encodings; only remove Kitty press/repeat annotations, never CSI-u.
  const legacy = data.replace(event, "");
  if (/^\x1b\[(?:1;[1-8][P-S]|(?:1[1-5]|1[7-9]|2[0134])(?:;[1-8])?~)$/.test(legacy)) return legacy;

  const printable = decodeKittyPrintable(data);
  if (printable !== undefined && !/[\x00-\x1f\x7f-\x9f\ud800-\udfff\ue000-\uf8ff]/u.test(printable)) {
    // Without Kitty's alternate-key flag, Pi returns the unshifted ASCII codepoint.
    // Prefer an explicitly reported shifted character (including non-ASCII layouts).
    if (keypad < 0 && id === `shift+${printable}`) return encodeKey(id, modes);
    return printable;
  }
  if (id) return encodeKey(id, modes);
  // Raw legacy Alt+text can be received even with Pi's Kitty mode active. Unknown
  // multi-byte escape packets and incomplete CSI/SS3 sequences must not fall through.
  if (!data.startsWith(CSI) && !data.startsWith(`${ESC}O`) && [...data].length === 2) return data;
  return undefined;
}
