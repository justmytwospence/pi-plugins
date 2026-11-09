import { describe, expect, it } from "vitest";
import { hintColumns } from "../src/panel.ts";

const id = (s: string) => s;
const hints = [
  { key: "enter", action: "ask" },
  { key: "ctrl+o", action: "expand" },
  { key: "/new", action: "fresh thread" },
  { key: "ctrl+'", action: "close" },
];

describe("hintColumns", () => {
  it("puts each action above its key, aligned in columns", () => {
    expect(hintColumns(hints, 80, undefined, id, id)).toEqual([
      " ask    expand  fresh thread  close ",
      " enter  ctrl+o  /new          ctrl+'",
    ]);
  });

  it("drops columns from the end but keeps close", () => {
    expect(hintColumns(hints, 24, undefined, id, id)).toEqual([
      " ask    expand  close ",
      " enter  ctrl+o  ctrl+'",
    ]);
  });

  it("leads with the stashed marker over a blank key cell", () => {
    expect(hintColumns([{ key: "ctrl+'", action: "close" }], 40, "stashed", id, id)).toEqual([
      " stashed  close ",
      "          ctrl+'",
    ]);
  });
});
