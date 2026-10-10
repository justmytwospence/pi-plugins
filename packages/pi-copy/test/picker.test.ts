import { expect, test } from "vitest";
import { Picker } from "../src/picker.ts";
import type { Segment } from "../src/segments.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const seg = (id: string, kind: Segment["kind"], text: string, order: number): Segment => ({ id, kind, text, turn: order, order });
const a = seg("S1", "command", "npm test", 0);
const b = seg("S2", "url", "https://example.com", 1);
const c = seg("S3", "code", "const x = 1;\nconst y = 2;", 2);

function make() {
  let chosen: Segment | undefined | null = null;
  const picker = new Picker({ suggested: [c, b, a], all: [c, b, a], ranking: "pending", lastTurn: 2 }, theme, () => undefined, (s) => {
    chosen = s;
  });
  return { picker, chosen: () => chosen };
}

test("move, filter, preview and copy", () => {
  const { picker, chosen } = make();
  expect(picker.render(80).join("\n")).toContain("ranking…");
  picker.handleInput("\x1b[B");
  expect(picker.items()[picker.cursor]?.id).toBe("S2");
  for (const ch of "npm") picker.handleInput(ch);
  expect(picker.items().map((s) => s.id)).toEqual(["S1"]);
  picker.handleInput("\x1b[C");
  expect(picker.render(80).join("\n")).toContain("npm test");
  picker.handleInput("\r");
  expect(chosen()).toEqual(a);
});

test("a ranking update moves an untouched cursor to the top", () => {
  const { picker } = make();
  picker.update({ suggested: [b, a, c], all: [c, b, a], ranking: "done", lastTurn: 2 });
  expect(picker.cursor).toBe(0);
});

test("ranking updates keep the cursor on the same piece; Esc clears then closes", () => {
  const { picker, chosen } = make();
  picker.handleInput("\x1b[B");
  picker.update({ suggested: [b, a, c], all: [c, b, a], ranking: "done", lastTurn: 2 });
  expect(picker.items()[picker.cursor]?.id).toBe("S2");
  picker.handleInput("x");
  picker.handleInput("\x1b");
  expect(picker.query).toBe("");
  picker.handleInput("\x1b");
  expect(chosen()).toBeUndefined();
});

test("every rendered line fits the width", () => {
  const { picker } = make();
  picker.handleInput(" ");
  for (const line of picker.render(30)) expect(line.length).toBeLessThanOrEqual(30 + 20);
});
