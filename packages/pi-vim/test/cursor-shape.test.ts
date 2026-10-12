import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CURSOR_MARKER } from "@earendil-works/pi-tui";

import {
  hasPromptCursorMarker,
  stripSoftwareCursorAfterMarker,
  stripSoftwareCursorWhenHardwareCursorIsUsed,
} from "../src/engine/cursor-shape.js";

const SW_START = "\x1b[7m";
const RESET = "\x1b[0m";
const RESET27 = "\x1b[27m";

describe("stripSoftwareCursorAfterMarker", () => {
  it("returns the line unchanged when there is no cursor marker", () => {
    assert.equal(stripSoftwareCursorAfterMarker("plain text"), "plain text");
  });

  it("returns the line unchanged when the marker has no software cursor", () => {
    const line = `${CURSOR_MARKER}abc`;
    assert.equal(stripSoftwareCursorAfterMarker(line), line);
  });

  it("removes the reverse-video wrapper but keeps the cursor glyph", () => {
    const line = `${CURSOR_MARKER}ab${SW_START}X${RESET}cd`;
    assert.equal(stripSoftwareCursorAfterMarker(line), `${CURSOR_MARKER}abXcd`);
  });

  it("also handles the \\x1b[27m reset variant", () => {
    const line = `${CURSOR_MARKER}${SW_START}Y${RESET27}z`;
    assert.equal(stripSoftwareCursorAfterMarker(line), `${CURSOR_MARKER}Yz`);
  });
});

describe("hasPromptCursorMarker", () => {
  it("is false when no line carries the marker", () => {
    assert.equal(hasPromptCursorMarker(["no", "marker", "here"]), false);
  });

  it("is true when any line carries the marker", () => {
    assert.equal(
      hasPromptCursorMarker(["plain", `${CURSOR_MARKER}here`]),
      true,
    );
  });
});

describe("stripSoftwareCursorWhenHardwareCursorIsUsed", () => {
  it("strips the software cursor in place on the marker line", () => {
    const lines = ["top", `${CURSOR_MARKER}ab${SW_START}X${RESET}cd`];
    stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
    assert.equal(lines[1], `${CURSOR_MARKER}abXcd`);
    assert.equal(lines[0], "top");
  });

  it("leaves marker-free buffers untouched", () => {
    const lines = ["a", "b"];
    stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
    assert.deepEqual(lines, ["a", "b"]);
  });

  it("only strips the last marker-bearing line", () => {
    const first = `${CURSOR_MARKER}p${SW_START}P${RESET}q`;
    const last = `${CURSOR_MARKER}r${SW_START}R${RESET}s`;
    const lines = [first, last];
    stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
    assert.equal(lines[1], `${CURSOR_MARKER}rRs`);
    assert.equal(lines[0], first);
  });
});
