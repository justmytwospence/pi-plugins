import { expect, test } from "vitest";
import { classify, Presence } from "../src/presence.ts";

const fresh = () => ({ inPaste: false });

test("classify: keys, focus reports and pastes", () => {
  expect(classify("a", fresh())).toEqual({ focus: undefined, input: true });
  expect(classify("\x1b[I", fresh())).toEqual({ focus: "in", input: false });
  expect(classify("\x1b[O", fresh())).toEqual({ focus: "out", input: false });
  expect(classify("\x1b[O\x1b[I", fresh()).focus).toBe("in");
  expect(classify("\x1b[200~hello\x1b[201~", fresh()).input).toBe(false);
  const s = fresh();
  expect(classify("\x1b[200~hel", s).input).toBe(false);
  expect(s.inPaste).toBe(true);
  expect(classify("lo\x1b[201~", s).input).toBe(false);
  expect(s.inPaste).toBe(false);
  const open = { inPaste: true };
  expect(classify("lo\x1b[201~x", open).input).toBe(true);
});

test("classify: terminal replies and hover are not input", () => {
  for (const r of ["\x1b]11;rgb:0000/0000/0000\x07", "\x1b[?62;22c", "\x1b[?1u", "\x1b[?997;1n", "\x1b[?2026;2$y", "\x1b[4;800;1200t", "\x1b[<35;10;5M"]) {
    expect(classify(r, fresh()).input, r).toBe(false);
  }
  expect(classify("\x1b[<0;10;5M", fresh()).input).toBe(true);
  expect(classify("\x1b[<64;10;5M", fresh()).input).toBe(true);
});

function presence(delayMs = 1000) {
  let t = 0;
  const p = new Presence({ delayMs, now: () => t });
  return { p, at: (n: number) => { t = n; } };
}
const key = { input: true };

test("Presence: unknown focus uses the delay", () => {
  const { p, at } = presence();
  at(999);
  expect(p.observe(key, 0)).toBe(false);
  at(1998);
  expect(p.observe(key, 0)).toBe(false);
  at(2998);
  expect(p.observe(key, 0)).toBe(true);
  at(3000);
  expect(p.observe(key, 0)).toBe(false);
});

test("Presence: focus-out then focus-in", () => {
  const a = presence();
  a.at(100);
  a.p.observe({ focus: "out", input: false }, 0);
  a.at(1100);
  expect(a.p.observe({ focus: "in", input: false }, 0)).toBe(true);
  const b = presence();
  b.at(100);
  b.p.observe({ focus: "out", input: false }, 0);
  b.at(600);
  expect(b.p.observe({ focus: "in", input: false }, 0)).toBe(false);
});

test("Presence: a focused window waits 5x", () => {
  const a = presence();
  a.p.observe({ focus: "in", input: false }, 0);
  a.at(4999);
  expect(a.p.observe(key, 0)).toBe(false);
  const b = presence();
  b.p.observe({ focus: "in", input: false }, 0);
  b.at(5000);
  expect(b.p.observe(key, 0)).toBe(true);
});

test("Presence: nothing pending never returns", () => {
  const { p, at } = presence();
  at(10_000);
  expect(p.observe(key, undefined)).toBe(false);
});
