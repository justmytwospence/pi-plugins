import { describe, it } from "node:test";
import { assertMatchesNvim, type NvimParityCase } from "./nvim-oracle.js";

const PARAGRAPH_FIXTURE = [
  "alpha one",
  "alpha two",
  "",
  "   ",
  "beta one",
  "beta two",
  "",
  "gamma one",
  "",
  "   ",
].join("\n");

const PARAGRAPH_MOTION_PARITY_CASES: NvimParityCase[] = [
  {
    name: "}: moves from paragraph text to the next paragraph boundary",
    initial: { text: PARAGRAPH_FIXTURE, cursor: { line: 0, col: 3 } },
    keys: ["}"],
  },
  {
    name: "2}: moves across two paragraph boundaries",
    initial: { text: PARAGRAPH_FIXTURE, cursor: { line: 0, col: 0 } },
    keys: ["2", "}"],
  },
  {
    name: "{: moves from paragraph text to the previous paragraph boundary",
    initial: { text: PARAGRAPH_FIXTURE, cursor: { line: 7, col: 2 } },
    keys: ["{"],
  },
  {
    name: "2{: moves across two paragraph boundaries",
    initial: { text: PARAGRAPH_FIXTURE, cursor: { line: 7, col: 0 } },
    keys: ["2", "{"],
  },
];

const MATCHING_PAIR_MOTION_PARITY_CASES: NvimParityCase[] = [
  {
    name: "%: jumps from opening parenthesis to closing parenthesis",
    initial: { text: "foo(bar)", cursor: { line: 0, col: 3 } },
    keys: ["%"],
  },
  {
    name: "%: jumps from closing parenthesis to opening parenthesis",
    initial: { text: "foo(bar)", cursor: { line: 0, col: 7 } },
    keys: ["%"],
  },
  {
    name: "%: jumps from opening bracket to closing bracket",
    initial: { text: "foo[bar]", cursor: { line: 0, col: 3 } },
    keys: ["%"],
  },
  {
    name: "%: jumps from closing bracket to opening bracket",
    initial: { text: "foo[bar]", cursor: { line: 0, col: 7 } },
    keys: ["%"],
  },
  {
    name: "%: jumps from opening brace to closing brace",
    initial: { text: "foo{bar}", cursor: { line: 0, col: 3 } },
    keys: ["%"],
  },
  {
    name: "%: jumps from closing brace to opening brace",
    initial: { text: "foo{bar}", cursor: { line: 0, col: 7 } },
    keys: ["%"],
  },
  {
    name: "%: scans forward on the current line to a matching pair",
    initial: { text: "foo (bar)", cursor: { line: 0, col: 0 } },
    keys: ["%"],
  },
];

const OPERATOR_MATCHING_PAIR_PARITY_CASES: NvimParityCase[] = [
  {
    name: "d%: deletes an opening-parenthesis match inclusively",
    initial: { text: "foo(bar)baz", cursor: { line: 0, col: 3 } },
    keys: ["d", "%"],
  },
  {
    name: "d%: deletes a closing-parenthesis match inclusively",
    initial: { text: "foo(bar)baz", cursor: { line: 0, col: 7 } },
    keys: ["d", "%"],
  },
  {
    name: "d%: deletes a bracket match inclusively",
    initial: { text: "foo[bar]baz", cursor: { line: 0, col: 3 } },
    keys: ["d", "%"],
  },
  {
    name: "d%: deletes a brace match inclusively",
    initial: { text: "foo{bar}baz", cursor: { line: 0, col: 3 } },
    keys: ["d", "%"],
  },
  {
    name: "y%: yanks a matching-pair range without mutating text",
    initial: { text: "foo(bar)baz", cursor: { line: 0, col: 3 } },
    keys: ["y", "%"],
  },
];

const KNOWN_NVIM_PARITY_GAPS = new Set([
  "}: moves from paragraph text to the next paragraph boundary",
  "2}: moves across two paragraph boundaries",
  "{: moves from paragraph text to the previous paragraph boundary",
  "2{: moves across two paragraph boundaries",
]);

describe("nvim parity structural motions", () => {
  for (const testCase of [
    ...PARAGRAPH_MOTION_PARITY_CASES,
    ...MATCHING_PAIR_MOTION_PARITY_CASES,
    ...OPERATOR_MATCHING_PAIR_PARITY_CASES,
  ]) {
    if (KNOWN_NVIM_PARITY_GAPS.has(testCase.name)) {
      it.skip(`known nvim parity gap: ${testCase.name}`);
      continue;
    }

    it(testCase.name, async () => {
      await assertMatchesNvim(testCase);
    });
  }
});
