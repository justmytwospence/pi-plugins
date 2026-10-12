import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isBackspaceLikeInput,
  isCountStarter,
  isDigit,
  isEnterLikeInput,
  isEscapeLikeInput,
  isPrintableChunk,
  isPrintableInput,
} from "../src/engine/input-keys.js";

describe("input-keys classification predicates", () => {
  it("recognizes escape-like input", () => {
    assert.equal(isEscapeLikeInput("\x1b"), true);
    assert.equal(isEscapeLikeInput("\x1b["), false);
    assert.equal(isEscapeLikeInput("a"), false);
  });

  it("recognizes enter-like input", () => {
    assert.equal(isEnterLikeInput("\r"), true);
    assert.equal(isEnterLikeInput("\n"), true);
    assert.equal(isEnterLikeInput("a"), false);
  });

  it("recognizes backspace-like input", () => {
    assert.equal(isBackspaceLikeInput("\x7f"), true);
    assert.equal(isBackspaceLikeInput("\x08"), true);
    assert.equal(isBackspaceLikeInput("a"), false);
  });

  it("classifies printable chunks by control-char content", () => {
    assert.equal(isPrintableChunk(""), false);
    assert.equal(isPrintableChunk("abc"), true);
    assert.equal(isPrintableChunk("é"), true);
    assert.equal(isPrintableChunk("a\x1b"), false);
    assert.equal(isPrintableChunk("\x7f"), false);
  });

  it("treats a single printable grapheme as printable input", () => {
    assert.equal(isPrintableInput("a"), true);
    assert.equal(isPrintableInput("👍"), true);
    assert.equal(isPrintableInput("ab"), false);
    assert.equal(isPrintableInput("\x1b"), false);
  });

  it("recognizes single-character digits and count starters", () => {
    assert.equal(isDigit("0"), true);
    assert.equal(isDigit("9"), true);
    assert.equal(isDigit("10"), false);
    assert.equal(isDigit("a"), false);

    assert.equal(isCountStarter("0"), false);
    assert.equal(isCountStarter("1"), true);
    assert.equal(isCountStarter("9"), true);
    assert.equal(isCountStarter("12"), false);
  });
});
