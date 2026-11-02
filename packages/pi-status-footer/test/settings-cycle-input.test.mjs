import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Resolve the same public SDK in the adapter and the native input pipeline. The
// installed-host run uses PI_TEST_SDK_ROOT without modifying either installation.
const sdk = process.env.PI_TEST_SDK_ROOT ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const requireSdk = createRequire(path.join(sdk, "package.json"));
const tuiPath = requireSdk.resolve("@earendil-works/pi-tui"), sdkPath = path.join(sdk, "dist/index.js");
const { createJiti } = await import(pathToFileURL(path.join(sdk, "dist/core/extensions/jiti-loader.js")));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-tui": tuiPath, "@earendil-works/pi-coding-agent": sdkPath } });
const { createSettingsCycleInput } = await jiti.import(fileURLToPath(new URL("../src/settings-cycle-input.ts", import.meta.url)));
const { isKeyRelease, matchesKey, decodeKittyPrintable, TuiMainScreen, getKeybindings, setKeybindings } = await import(pathToFileURL(tuiPath));
const { CustomEditor } = await import(pathToFileURL(sdkPath));
const { KeybindingsManager } = await import(pathToFileURL(path.join(sdk, "dist/core/keybindings.js")));
const { initTheme, getEditorTheme } = await import(pathToFileURL(path.join(sdk, "dist/modes/interactive/theme/theme.js")));

const CSI = "\x1b[", POP = `${CSI}<u`, QUERY = `${CSI}?u`;
const chord = (mods = 4, event = 1, key = 112) => `${CSI}${key};${mods + 1}:${event}u`;
const modifier = (key = 57442, event = 3, mods = 0) => chord(mods, event, key);
const created = [];
function host({ kitty = true, restore = false, inputTTY = true, outputTTY = true, terminal: changes = {} } = {}) {
  const stdin = new EventEmitter(), exitSource = new EventEmitter(), microtasks = [], writes = [], delivered = [], modes = [], cancellations = [];
  const releases = vi.fn(), handlers = new Set();
  let session = "main", factory, focused, overlay = false;
  const editor = { render: () => [], handleInput: vi.fn(data => delivered.push(data)) };
  const terminal = {
    kittyProtocolActive: kitty,
    write(data) { writes.push(data); },
    stop() { this.write("host-stop"); this.write(POP); },
    drainInput() { this.write("host-drain"); this.write(POP); return Promise.resolve(); },
    start() { this.write("host-start"); },
    ...(restore ? { restoreOnExit(before, after) { writes.push(before + POP + after); } } : {}),
    ...changes,
  };
  const originals = Object.getOwnPropertyDescriptors(terminal);
  const tui = { terminal, getFocusedComponent: () => focused, hasOverlay: () => overlay };
  const ctx = { hasUI: true, mode: "tui", sessionManager: { getSessionId: () => session }, ui: {
    getEditorComponent: () => factory,
    setEditorComponent(next) { factory = next; if (next) focused = next(tui, {}, {}); },
    onTerminalInput(fn) { handlers.add(fn); return () => handlers.delete(fn); },
  } };
  const input = createSettingsCycleInput({ stdin, exitSource, isInputTTY: () => inputTTY, isOutputTTY: () => outputTTY,
    writeSync: data => writes.push(data), queueMicrotask: fn => microtasks.push(fn), createEditor: () => editor,
  }, { release: releases, mode: status => modes.push(status), cancel: reason => cancellations.push(reason) });
  input.bind(ctx); created.push(input);
  const h = { input, stdin, exitSource, writes, delivered, modes, cancellations, releases, ctx, terminal, originals, tui, editor, handlers,
    key(data) {
      let value = data;
      for (const fn of [...handlers]) {
        const result = fn(value);
        if (result?.consume) return { trigger: input.captureTrigger(), data: undefined };
        value = result?.data ?? value;
      }
      // This is the real SDK's release check, in the same position as TuiBase.
      if (value && !isKeyRelease(value)) focused?.handleInput?.(value);
      return { trigger: input.captureTrigger(), data: value };
    },
    reply(flags) { stdin.emit("data", `${CSI}?${flags}u`); },
    raw(data) { stdin.emit("data", data); },
    flush() { while (microtasks.length) microtasks.shift()(); },
    begin(mods = 4) { const token = {}; const trigger = h.key(chord(mods)).trigger; input.begin(token, trigger); return { token, trigger }; },
    negotiate(flags = 7, ack = flags | 31) { h.reply(flags); h.reply(ack); },
    confirm() { h.key(chord(4, 3)); },
    set focus(value) { focused = value; }, get focus() { return focused; },
    set overlay(value) { overlay = value; },
    set session(value) { session = value; },
    set factory(value) { factory = value; }, get factory() { return factory; },
  };
  return h;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const input of created.splice(0)) input.dispose(); vi.useRealTimers(); });

describe("scoped Kitty handshake", () => {
  it("queries, preserves all baseline bits, pushes once, and pops exactly once", () => {
    const h = host(); h.begin();
    expect(h.input.status()).toEqual({ mode: "negotiating", modifiers: ["ctrl"], reason: "unconfirmed" });
    expect(h.writes).toEqual([QUERY]);
    h.negotiate(71, 95);
    expect(h.writes).toEqual([QUERY, `${CSI}>95u`, QUERY]);
    // A full acknowledgement cannot strand a batch on an already released modifier.
    expect(h.input.status().mode).toBe("negotiating");
    h.input.close(); h.input.close(); h.input.dispose();
    expect(h.writes.filter(s => s === POP)).toHaveLength(1);
  });
  it("requires post-push held evidence even after a full acknowledgement", () => {
    const h = host(); h.begin(); h.negotiate();
    expect(h.input.status().reason).toBe("unconfirmed");
    vi.advanceTimersByTime(3000); expect(h.releases).not.toHaveBeenCalled();
    h.confirm(); expect(h.input.status().mode).toBe("modifier-release");
    vi.advanceTimersByTime(3000); expect(h.releases).not.toHaveBeenCalled();
    h.key(modifier()); expect(h.releases).toHaveBeenCalledTimes(1);
    expect(h.input.status()).toEqual({ mode: "idle", modifiers: [] });
  });
  it("accepts held evidence between push and acknowledgement", () => {
    const h = host(); h.begin(); h.reply(7); h.confirm();
    expect(h.input.status().mode).toBe("negotiating"); h.reply(31);
    expect(h.input.status().mode).toBe("modifier-release");
  });
  it("a genuine release before baseline/ack commits immediately and late replies stay inert", () => {
    for (const pushed of [false, true]) {
      const h = host(); h.begin(); if (pushed) h.reply(7);
      h.key(modifier()); expect(h.releases).toHaveBeenCalledTimes(1);
      h.reply(31); h.reply(31);
      expect(h.input.status().mode).toBe("idle");
      expect(h.writes.filter(s => s.startsWith(`${CSI}>`))).toHaveLength(pushed ? 1 : 0);
    }
  });
  it.each([undefined, false])("does not query or push behind a missing/false host flag (%s)", kitty => {
    const h = host({ kitty }); if (kitty === undefined) delete h.terminal.kittyProtocolActive;
    h.begin(); expect(h.writes).toEqual([]);
    expect(h.input.status()).toEqual({ mode: "timer", modifiers: ["ctrl"], reason: "unavailable" });
    expect(h.key("\x1bp").data).toBe("\x1bp"); expect(h.key("\x10").data).toBe("\x10");
  });
  it.each([{ inputTTY: false }, { outputTTY: false }])("requires both immediate TTYs (%j)", config => {
    const h = host(config); h.begin(); expect(h.writes).toEqual([]); expect(h.input.status().mode).toBe("timer");
  });
  it("rejects zero baseline without a push", () => {
    const h = host(); h.begin(); h.reply(0);
    expect(h.writes).toEqual([QUERY]); expect(h.input.status().reason).toBe("unsupported");
  });
  it.each([7, 15, 23, 0])("pops partial flags %i and keeps fallback", ack => {
    const h = host(); h.begin(); h.negotiate(7, ack);
    expect(h.writes.at(-1)).toBe(POP); expect(h.input.status()).toEqual({ mode: "timer", modifiers: ["ctrl"], reason: "partial" });
    h.confirm(); expect(h.input.status().mode).toBe("timer");
  });
  it("no reply/dropped ack retains negotiating fallback and closes cleanly", () => {
    const h = host(); h.begin(); vi.advanceTimersByTime(1000);
    expect(h.input.status().mode).toBe("negotiating"); expect(h.writes).toEqual([QUERY]);
    h.reply(7); vi.advanceTimersByTime(1000); expect(h.input.status().mode).toBe("negotiating");
    h.input.close(); expect(h.writes.at(-1)).toBe(POP);
  });
  it("tombstones orphan queries so they cannot open a new transaction", () => {
    const h = host(); h.begin(); h.input.close(); h.begin();
    h.reply(7); expect(h.writes).toEqual([QUERY, QUERY]);
    h.reply(7); expect(h.writes.at(-2)).toBe(`${CSI}>31u`);
    h.input.close(); h.reply(31); expect(h.input.status().mode).toBe("idle");
  });
  it("fences orphan baseline replies when keyboard negotiation restarts within the same transaction", () => {
    const h = host(); h.begin(); h.input.touch({ kind: "pointer" });
    h.input.touch(h.key(chord()).trigger); expect(h.writes).toEqual([QUERY, QUERY]);
    h.reply(7); expect(h.writes).toEqual([QUERY, QUERY]);
    h.negotiate(); h.confirm(); expect(h.input.status().mode).toBe("modifier-release");
  });
  it("stops and fences a pending handshake on terminal restart", () => {
    const h = host(); h.begin(); const trigger = h.input.captureTrigger();
    h.terminal.stop(); h.terminal.start(); h.reply(7);
    expect(h.cancellations).toEqual(["terminal stop"]);
    h.input.begin({}, trigger); expect(h.input.status().mode).toBe("timer");
    expect(h.writes.filter(s => s.startsWith(`${CSI}>`))).toEqual([]);
    h.begin(); h.negotiate(); h.confirm(); expect(h.input.status().mode).toBe("modifier-release");
  });
});

describe("passive bounded negotiation scanner", () => {
  it("observes before host listeners without changing/consuming raw stdin", () => {
    const h = host(), observations = [];
    h.stdin.on("data", data => observations.push([data, h.writes.length]));
    h.begin(); h.raw(Buffer.from(`${CSI}?7u`));
    expect(observations).toEqual([[Buffer.from(`${CSI}?7u`), 3]]);
    expect(h.stdin.listenerCount("data")).toBe(2);
    h.input.dispose(); expect(h.stdin.listenerCount("data")).toBe(1);
  });
  it("handles fragmented and coalesced flags", () => {
    const h = host(); h.begin();
    for (const c of `${CSI}?7u${CSI}?31u`) h.raw(c);
    h.confirm(); expect(h.input.status().mode).toBe("modifier-release");
    const other = host(); other.begin(); other.raw(`${CSI}?7u${CSI}?31u`); other.confirm();
    expect(other.input.status().mode).toBe("modifier-release");
  });
  it.each([
    `${CSI}200~${CSI}?7u${CSI}201~`,
    `\x1b]title;${CSI}?7u\x07`, `\x1bPbody${CSI}?7u\x1b\\`, `\x1b_body${CSI}?7u\x1b\\`,
    `\x1b^body${CSI}?7u\x1b\\`,
  ])("ignores reply-looking paste/control bodies, even at every fragmented boundary", payload => {
    const h = host(); h.begin(); for (const c of payload) h.raw(c);
    expect(h.writes).toEqual([QUERY]); h.negotiate(); h.confirm();
    expect(h.input.status().mode).toBe("modifier-release");
  });
  it("bounds malformed candidates and rejects noninteger/overflow flags", () => {
    const h = host(); h.begin();
    h.raw(`${CSI}?${"9".repeat(10000)}u${CSI}?999999999999999999u${CSI}?1;31u`);
    expect(h.writes).toEqual([QUERY]); h.negotiate(); h.confirm(); expect(h.input.status().mode).toBe("modifier-release");
  });
});

describe("triggers and modifier state", () => {
  it("captures only the synchronous turn and scopes synchronously even for promises/errors", async () => {
    const h = host(), keyboard = h.key(chord()).trigger;
    expect(keyboard).toMatchObject({ kind: "keyboard", modifiers: 4, event: "press" });
    h.flush(); expect(h.input.captureTrigger()).toBeUndefined();
    const pointer = { kind: "pointer" }, programmatic = { kind: "programmatic" };
    h.input.withTrigger(pointer, () => {
      expect(h.input.captureTrigger()).toBe(pointer);
      expect(() => h.input.withTrigger(programmatic, () => { throw Error("test"); })).toThrow("test");
      expect(h.input.captureTrigger()).toBe(pointer);
    });
    let release; const waiting = new Promise(resolve => { release = resolve; });
    const result = h.input.withTrigger(pointer, () => waiting);
    expect(result).toBe(waiting); expect(h.input.captureTrigger()).toBeUndefined(); release(); await result;
  });
  it("accepts retained tokens across awaits, including release before staging", async () => {
    const h = host(), trigger = h.key(chord()).trigger;
    h.flush(); await Promise.resolve(); h.key(modifier());
    h.input.begin({}, trigger); expect(h.releases).toHaveBeenCalledTimes(1);
    expect(h.writes).toEqual([]);
  });
  it("rejects copied, stale-epoch, fabricated and evicted tokens", () => {
    const h = host(), trigger = h.key(chord()).trigger;
    h.input.begin({}, { ...trigger }); expect(h.input.status().mode).toBe("timer");
    h.input.close(); h.input.bind(h.ctx); h.input.begin({}, trigger); expect(h.input.status().mode).toBe("timer");
    h.input.close(); const old = h.key(chord()).trigger;
    for (let i = 0; i < 300; i++) h.key(chord());
    h.input.begin({}, old); expect(h.input.status().mode).toBe("timer");
  });
  it("degrades a retained token when its bounded release evidence was evicted", () => {
    const h = host(), trigger = h.key(chord()).trigger;
    for (let i = 0; i < 300; i++) h.key(modifier(57443));
    h.input.begin({}, trigger); expect(h.input.status().mode).toBe("timer"); expect(h.writes).toEqual([]);
  });
  it("tracks both physical sides without committing on the first release", () => {
    const h = host(); h.begin(); h.negotiate();
    h.key(modifier(57442, 1, 4)); h.key(modifier(57448, 1, 4));
    expect(h.input.status().mode).toBe("modifier-release");
    h.key(modifier(57442, 3, 0)); expect(h.releases).not.toHaveBeenCalled();
    h.key(modifier(57448, 3, 0)); expect(h.releases).toHaveBeenCalledTimes(1);
  });
  it("trusts the post-event mask when the other physical side predates the lease", () => {
    const h = host(); h.begin(); h.negotiate();
    // Left Ctrl was already held for the initiating chord; only right Ctrl down
    // is observable once all-keys reporting has been leased.
    h.key(modifier(57448, 1, 4)); h.key(modifier(57448, 3, 4));
    expect(h.releases).not.toHaveBeenCalled(); expect(h.input.status().mode).toBe("modifier-release");
    h.key(modifier(57442, 3, 0)); expect(h.releases).toHaveBeenCalledTimes(1);
  });
  it("accumulates mixed chords and waits for all participating logical modifiers", () => {
    const h = host(); h.begin(4); h.negotiate();
    const alt = h.key(chord(6, 2)).trigger; h.input.touch(alt);
    expect(h.input.status().modifiers).toEqual(["ctrl", "alt"]);
    h.key(modifier(57442, 3, 2)); expect(h.releases).not.toHaveBeenCalled();
    h.key(modifier(57443, 3, 0)); expect(h.releases).toHaveBeenCalledTimes(1);
  });
  it("confirms a remaining held modifier when another participating modifier is already up", () => {
    const h = host(); h.begin(6); h.negotiate(); h.key(modifier(57442, 3, 2));
    expect(h.releases).not.toHaveBeenCalled(); expect(h.input.status().mode).toBe("modifier-release");
    vi.advanceTimersByTime(3000); expect(h.releases).not.toHaveBeenCalled();
    h.key(modifier(57443, 3, 0)); expect(h.releases).toHaveBeenCalledTimes(1);
  });
  it.each([[1, 57441], [2, 57443], [4, 57442], [8, 57444]])("tracks logical modifier %i", (bit, key) => {
    const h = host(); h.begin(bit); h.negotiate(); h.key(modifier(key, 1, bit));
    expect(h.input.status().mode).toBe("modifier-release"); h.key(modifier(key, 3)); expect(h.releases).toHaveBeenCalledTimes(1);
  });
  it("ignores unrelated modifier/lock releases and lock bits", () => {
    const h = host(); h.begin(4 | 64 | 128); h.negotiate();
    expect(h.input.status().modifiers).toEqual(["ctrl"]);
    h.key(modifier(57443)); h.key(modifier(57358)); h.key(modifier(57445));
    expect(h.releases).not.toHaveBeenCalled();
    h.key(chord(4 | 64, 3)); expect(h.input.status().mode).toBe("modifier-release");
    h.key(modifier(57442, 3, 64)); expect(h.releases).toHaveBeenCalledTimes(1);
  });
  it("recovers a lost release from a later trustworthy full mask", () => {
    const h = host(); h.begin(); h.negotiate(); h.confirm();
    h.key(chord(0, 1, 97)); expect(h.releases).toHaveBeenCalledTimes(1);
    h.key(modifier()); expect(h.releases).toHaveBeenCalledTimes(1);
  });
  it.each([{ kind: "pointer" }, { kind: "programmatic" }])("switches %j to timer without inheriting a hold", trigger => {
    const h = host(); h.begin(); h.negotiate(); h.confirm(); h.input.touch(trigger);
    expect(h.writes.at(-1)).toBe(POP); expect(h.input.status()).toEqual({ mode: "timer", modifiers: [], reason: trigger.kind });
    h.key(modifier()); expect(h.releases).not.toHaveBeenCalled();
    const next = h.key(chord()).trigger; h.input.touch(next); h.negotiate(); h.confirm();
    expect(h.input.status().mode).toBe("modifier-release");
  });
  it("unmodified keyboard actions use timer", () => {
    const h = host(); h.begin(0); expect(h.writes).toEqual([]);
    expect(h.input.status()).toEqual({ mode: "timer", modifiers: [], reason: "unmodified" });
  });
  it.each(["focus", "overlay", "session"])("cancels instead of releasing across %s loss", kind => {
    const h = host(); h.begin(); h.negotiate(); h.confirm();
    if (kind === "focus") h.focus = { handleInput() {} };
    if (kind === "overlay") h.overlay = true;
    if (kind === "session") h.session = "other";
    h.key(modifier()); expect(h.releases).not.toHaveBeenCalled(); expect(h.cancellations).toHaveLength(1);
    expect(h.writes.at(-1)).toBe(POP);
  });
});

describe("enhanced stream normalization", () => {
  it.each([
    [`${CSI}97u`, "a"], [`${CSI}97;;u`, "a"], [`${CSI}97:65:97;2:2u`, "A"],
    [`${CSI}101;1;101:769u`, "e\u0301"], [`${CSI}0;;26085:26412u`, "日本"],
    [`${CSI}101;7;233u`, "é"], [`${CSI}97;1;128512:32:945u`, "😀 α"],
    [`${CSI}97;1;57344u`, "\ue000"],
  ])("preserves authoritative ordinary text %j -> %j exactly once", (sequence, text) => {
    const h = host(); expect(h.key(sequence).data).toBe(text); expect(h.delivered).toEqual([text]);
  });
  it("retains shortcut identity, modifiers, alternate keys and repeat/release event type", () => {
    const h = host();
    expect(h.key(`${CSI}112:80:112;6:2;u`).data).toBe(`${CSI}112:80:112;6:2u`);
    expect(matchesKey(h.delivered[0], "ctrl+shift+p")).toBe(true);
    expect(h.key(`${CSI}112::112;5:3;112u`).data).toBe(`${CSI}112::112;5:3u`);
    expect(h.delivered).toHaveLength(1); expect(h.input.captureTrigger()).toBeUndefined();
  });
  it.each([2, 4, 6, 8, 12])("preserves control modifier mask %i when a terminal attaches the unmodified letter", modifiers => {
    const h = host(); const data = h.key(`${CSI}112:80:112;${modifiers + 1}:2;112u`).data;
    expect(data).toBe(`${CSI}112:80:112;${modifiers + 1}:2u`);
  });
  it.each([[2, 101, "233", "é"], [6, 113, "64", "@"], [6, 101, "101:769", "e\u0301"]])("preserves translated AltGr/Option text (%i, %i)", (mods, key, text, expected) => {
    const h = host(); expect(h.key(`${CSI}${key};${mods + 1};${text}u`).data).toBe(expected);
  });
  it("never turns release into associated text or a second action", () => {
    const h = host(); let cycles = 0;
    const native = h.editor.handleInput;
    h.editor.handleInput = data => { if (matchesKey(data, "ctrl+p")) cycles++; native(data); };
    h.key(chord()); h.key(`${CSI}112;5:3;112u`);
    expect(cycles).toBe(1); expect(h.delivered).toHaveLength(1);
  });
  it.each([57441, 57442, 57447, 57448, 57454])("consumes standalone modifier %i", key => {
    const h = host(); expect(h.key(chord(0, 1, key)).data).toBeUndefined(); expect(h.delivered).toEqual([]);
    expect(h.input.captureTrigger()).toBeUndefined();
  });
  it("does not decode Kitty functional/private-use key numbers but preserves raw private-use text", () => {
    const h = host();
    expect(h.key(`${CSI}57344;1;65u`).data).toBe(`${CSI}27;1:1u`);
    expect(h.key("\ue123").data).toBe("\ue123"); expect(h.delivered.at(-1)).toBe("\ue123");
  });
  it("preserves unknown/legacy sequences and bracketed paste byte for byte", () => {
    const h = host();
    for (const data of ["\x1b[A", "\x1b[Z", "\x1bOP", "\x01", `${CSI}200~${CSI}57441u${CSI}?7u日本${CSI}201~`]) expect(h.key(data).data).toBe(data);
    expect(h.input.captureTrigger()).toBeUndefined();
  });
  it("preserves fragmented paste and resumes normalization after its terminator", () => {
    const h = host();
    for (const data of [`${CSI}200~text${CSI}?31u`, "\x1b[20", "1~"]) expect(h.key(data).data).toBe(data);
    expect(h.key(`${CSI}97u`).data).toBe("a");
  });
  it("normalizes fragmented/coalesced CSI-u input and in-flight events after pop", () => {
    const h = host(); h.begin(); h.negotiate(); h.input.close();
    expect(h.key(`${CSI}97;1;`).data).toBeUndefined();
    expect(h.key("233u").data).toBe("é");
    expect(h.key(`${CSI}98u${CSI}99u`).data).toBe("bc");
    h.key(`${CSI}57442;1:3u`); expect(h.delivered.at(-1)).toBe("bc");
  });
  it("does not let coalesced release filtering swallow adjacent ordinary text", () => {
    const h = host(); expect(h.key(`${CSI}112;5:3;112u${CSI}97;1;233u`).data).toBe("é");
    expect(h.delivered).toEqual(["é"]);
  });
  it.each([[9, "tab"], [13, "enter"], [127, "backspace"], [57346, "tab"], [57345, "enter"], [57347, "backspace"], [57414, "enter"], [57350, "left"], [57419, "up"], [57349, "delete"]])("preserves encoded native control %i as %s", (number, name) => {
    const h = host(), data = h.key(`${CSI}${number};1;65u`).data;
    expect(matchesKey(data, name)).toBe(true);
    // The host printable helper also decodes DEL; native Backspace routing must
    // win before that fallback. No private-use functional glyph is ever returned.
    expect(decodeKittyPrintable(data)).toBe(name === "backspace" ? "\x7f" : undefined);
  });
  it.each([57358, 57376, 57427, 57440, 0xe123])("consumes unsupported functional/private-use key %i without glyphs", number => {
    const h = host(); expect(h.key(`${CSI}${number};1u`).data).toBeUndefined(); expect(h.delivered).toEqual([]);
  });
  it("preserves supported F keys and safely canonicalizes keypad text", () => {
    const h = host(); expect(matchesKey(h.key(`${CSI}57364;1u`).data, "f1")).toBe(true);
    expect(h.key(`${CSI}57399;1;48u`).data).toBe("0");
    const numpad = h.key(`${CSI}57400;1u`).data;
    expect(decodeKittyPrintable(numpad)).toBe("1");
    expect(h.key(`${CSI}57364;1:3u`).data).toBe(`${CSI}11;1:3~`);
    expect(h.key(`${CSI}57399;5;48u`).data).toBe(`${CSI}48;5:1u`);
  });
  it("guards malformed functional events and PUA alternate-key decoder fallthrough", () => {
    const h = host(); expect(h.key(`${CSI}57441;1:4u`).data).toBeUndefined();
    expect(h.key(`${CSI}97:57441;2u`).data).toBe("a"); expect(h.delivered).toEqual(["a"]);
  });
  it("does not interpret CSI-u inside OSC/DCS/APC input", () => {
    const h = host();
    for (const sequence of [`\x1b]title${CSI}97u\x07`, `\x1bP${CSI}97u\x1b\\`, `\x1b_${CSI}97u\x1b\\`]) expect(h.key(sequence).data).toBe(sequence);
  });
});

describe("public editor and terminal lifecycle ownership", () => {
  it("returns the prior factory's same editor and never wraps handleInput/action maps", () => {
    const h = host(), original = h.editor.handleInput, nativeFactory = vi.fn(() => h.editor);
    h.input.dispose(); h.factory = nativeFactory; h.input.bind(h.ctx);
    expect(nativeFactory).toHaveBeenCalledTimes(1); expect(h.focus).toBe(h.editor); expect(h.editor.handleInput).toBe(original);
    h.begin(); h.negotiate(); h.confirm(); h.input.close(); expect(nativeFactory).toHaveBeenCalledTimes(1);
  });
  it.each([{ hasUI: false, sessionManager: {} }, { hasUI: true, mode: "rpc", sessionManager: {} }, { hasUI: true, mode: "tui", sessionManager: {}, ui: {} }])("binds a minimal non-interactive/missing-API context without touching session methods (%j)", ctx => {
    const h = host(); expect(() => h.input.bind(ctx)).not.toThrow();
    h.input.begin({}, { kind: "programmatic" }); expect(h.input.status().mode).toBe("timer");
    expect(h.writes).toEqual([]); expect(h.stdin.listenerCount("data")).toBe(0);
    h.input.bind(h.ctx); h.begin(); h.negotiate(); h.confirm(); expect(h.input.status().mode).toBe("modifier-release");
  });
  it("rebinds after dispose without rebuilding a retired editor on shutdown", () => {
    const h = host(), stale = h.factory;
    h.begin(); h.negotiate(); h.input.dispose();
    expect(h.factory).toBe(stale); expect(h.handlers.size).toBe(0); expect(h.stdin.listenerCount("data")).toBe(0);
    h.input.bind(h.ctx); expect(h.factory).not.toBe(stale); expect(h.handlers.size).toBe(1);
    h.begin(); h.negotiate(); h.confirm(); expect(h.input.status().mode).toBe("modifier-release");
  });
  it("retires timer-only capture without cancelling pending submit flush when replaced non-compositionally", () => {
    const h = host({ kitty: false }); h.begin();
    h.ctx.ui.setEditorComponent(() => ({ handleInput() {} }));
    h.key("\r"); expect(h.cancellations).toEqual([]); expect(h.releases).not.toHaveBeenCalled();
    expect(h.input.status()).toEqual({ mode: "timer", modifiers: [], reason: "unavailable" });
  });
  it("retires an unpushed handshake on a late reply but cancels an actually owned lease", () => {
    const h = host(); h.begin(); h.ctx.ui.setEditorComponent(() => ({ handleInput() {} }));
    h.reply(7); expect(h.cancellations).toEqual([]); expect(h.writes).toEqual([QUERY]);
    expect(h.input.status().mode).toBe("timer");
    const other = host(); other.begin(); other.negotiate(); other.confirm();
    other.ctx.ui.setEditorComponent(() => ({ handleInput() {} })); other.key("\r");
    expect(other.cancellations).toHaveLength(1); expect(other.writes.at(-1)).toBe(POP);
  });
  it("retains composed newer factories and never reclaims an uncomposed editor", () => {
    const h = host(), ours = h.factory;
    const composed = (...args) => ours(...args); h.ctx.ui.setEditorComponent(composed);
    h.begin(); h.negotiate(); h.confirm(); expect(h.input.status().mode).toBe("modifier-release"); h.input.close();
    const foreign = () => ({ handleInput() {} }); h.ctx.ui.setEditorComponent(foreign);
    const trigger = h.key(chord()).trigger; h.input.begin({}, trigger ?? { kind: "programmatic" });
    expect(h.input.status().mode).toBe("timer"); expect(h.factory).toBe(foreign);
    h.input.dispose(); expect(h.factory).toBe(foreign);
  });
  it.each(["stop", "drainInput"])("pops before host %s and cancels exactly once", method => {
    const h = host(); h.begin(); h.negotiate(); h.confirm(); h.writes.length = 0;
    h.terminal[method]();
    expect(h.writes).toEqual([POP, method === "stop" ? "host-stop" : "host-drain", POP]);
    expect(h.cancellations).toEqual([`terminal ${method}`]); h.input.close(); expect(h.writes).toHaveLength(3);
  });
  it("prepends its emergency pop to optional synchronous restoreOnExit", () => {
    const h = host({ restore: true }); h.begin(); h.negotiate(); h.writes.length = 0;
    h.terminal.restoreOnExit("before", "after");
    expect(h.writes).toEqual([`${POP}before${POP}after`]);
    h.terminal.restoreOnExit("before", "after"); expect(h.writes.at(-1)).toBe(`before${POP}after`);
    expect(h.exitSource.listenerCount("exit")).toBe(0);
  });
  it("uses a prepended synchronous exit pop on SDK 1.2 hosts without restoreOnExit", () => {
    const h = host(), order = []; h.exitSource.on("exit", () => order.push(h.writes.at(-1)));
    h.begin(); h.negotiate(); h.writes.length = 0; h.exitSource.emit("exit"); h.exitSource.emit("exit");
    expect(h.writes).toEqual([POP]); expect(order).toEqual([POP, POP]);
    h.input.dispose(); expect(h.exitSource.listenerCount("exit")).toBe(1);
  });
  it("restores own descriptors/listeners without undoing newer foreign wrappers", () => {
    const h = host(), old = h.terminal.stop, newer = vi.fn(function() { return old.call(this); });
    h.terminal.stop = newer; h.input.dispose(); expect(h.terminal.stop).toBe(newer);
    const n = h.cancellations.length; h.terminal.stop(); expect(h.cancellations).toHaveLength(n);
    for (const name of ["write", "drainInput", "start"]) expect(Object.getOwnPropertyDescriptor(h.terminal, name)).toEqual(h.originals[name]);
  });
  it("does not pop through a later cooperative keyboard-stack owner", () => {
    const h = host(); h.begin(); h.negotiate();
    h.terminal.write(`${CSI}>7u`); h.input.close();
    expect(h.writes.filter(s => s === POP)).toHaveLength(0);
    h.terminal.write(POP); expect(h.writes.slice(-2)).toEqual([POP, POP]);
    h.input.close(); expect(h.writes.filter(s => s === POP)).toHaveLength(2);
  });
  it("defers only the owned pop/descriptor cleanup until a foreign stack owner unwinds after dispose", () => {
    const h = host(); h.begin(); h.negotiate();
    h.terminal.write(`${CSI}>7u`); h.input.dispose();
    expect(h.writes.filter(s => s === POP)).toHaveLength(0);
    expect(h.stdin.listenerCount("data")).toBe(0); expect(h.exitSource.listenerCount("exit")).toBe(0);
    h.terminal.write(POP);
    expect(h.writes.slice(-2)).toEqual([POP, POP]);
    expect(Object.getOwnPropertyDescriptor(h.terminal, "write")).toEqual(h.originals.write);
  });
  it("degrades if required public lifecycle methods are read-only/missing", () => {
    const h = host(); h.input.dispose();
    Object.defineProperty(h.terminal, "stop", { value() {}, writable: false, configurable: false });
    h.input.bind(h.ctx); h.begin(); expect(h.input.status().mode).toBe("timer"); expect(h.writes).toEqual([]);
  });
  it("status returns sanitized snapshots, not mutable internal modifier arrays", () => {
    const h = host(); h.begin(); const status = h.input.status(); status.modifiers.push("alt");
    expect(h.input.status().modifiers).toEqual(["ctrl"]); expect(JSON.stringify(h.input.status())).not.toContain("serial");
  });
});

function nativeHost(run) {
  initTheme("dark", false);
  const oldKeys = getKeybindings(), keys = new KeybindingsManager({ "app.thinking.cycle": "ctrl+p" });
  setKeybindings(keys);
  const writes = [], stdin = new EventEmitter(), exitSource = new EventEmitter();
  const terminal = { columns: 100, rows: 30, kittyProtocolActive: true,
    start(fn) { this.input = fn; }, stop() {}, async drainInput() {}, write(data) { writes.push(data); },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const tui = new TuiMainScreen(terminal, false), editor = new CustomEditor(tui, getEditorTheme(), keys);
  let factory = () => editor, cycles = 0, releases = 0;
  const ctx = { hasUI: true, mode: "tui", sessionManager: { getSessionId: () => "native" }, ui: {
    getEditorComponent: () => factory,
    setEditorComponent(fn) { factory = fn; fn(tui, getEditorTheme(), keys); },
    onTerminalInput: fn => tui.addInputListener(fn),
  } };
  const input = createSettingsCycleInput({ stdin, exitSource, isInputTTY: () => true, isOutputTTY: () => true, writeSync: data => writes.push(data), queueMicrotask: () => {} }, {
    release() { releases++; expect(writes.at(-1)).toBe(POP); }, mode() {}, cancel() {},
  });
  const token = {};
  editor.actionHandlers.set("app.thinking.cycle", () => { cycles++; input.begin(token, input.captureTrigger()); });
  tui.addChild(editor); tui.setFocus(editor); input.bind(ctx); tui.start();
  try {
    run({ input, editor, tui, writes, send: data => terminal.input(data),
      reply: flags => stdin.emit("data", `${CSI}?${flags}u`), get cycles() { return cycles; }, get releases() { return releases; } });
  } finally { input.dispose(); tui.stop({ preserveScreen: true }); editor.dispose?.(); setKeybindings(oldKeys); }
}

describe("real public TUI and CustomEditor pipeline", () => {
  it("observes before native release filtering, retains a long hold and releases only once", () => nativeHost(h => {
    h.send(`${CSI}112;5:1;112u`); expect(h.cycles).toBe(1);
    h.reply(7); h.reply(31); h.send(chord(4, 3));
    expect(h.cycles).toBe(1); expect(h.input.status().mode).toBe("modifier-release");
    vi.advanceTimersByTime(3000); expect(h.releases).toBe(0);
    h.send(chord(4, 2)); expect(h.cycles).toBe(2);
    h.send(modifier()); expect(h.releases).toBe(1); expect(h.cycles).toBe(2);
    expect(h.editor.getText()).toBe("");
  }));
  it("keeps cursor, native Backspace, history, paste and Unicode ownership in the editor", () => nativeHost(h => {
    h.editor.setText("ab"); h.send(`${CSI}57350u`);
    h.send(`${CSI}101;7;233u`); h.send(`${CSI}0;;26085:26412u`);
    expect(h.editor.getText()).toBe("aé日本b");
    h.send(`${CSI}57347u`); expect(h.editor.getText()).toBe("aé日b");
    h.send(`${CSI}200~\ue123${CSI}?31u${CSI}201~`);
    // The native editor itself strips ESC from pasted controls. The adapter's
    // byte-for-byte paste contract is checked separately above.
    expect(h.editor.getText()).toContain("\ue123[?31u");
    const before = h.editor.getText(); h.send(`${CSI}57440u`); h.send(`${CSI}57441u`); h.send(`${CSI}57376u`);
    expect(h.editor.getText()).toBe(before);
    h.editor.setText(""); h.editor.addToHistory("history entry"); h.send(`${CSI}57352u`);
    expect(h.editor.getText()).toBe("history entry");
  }));
});
