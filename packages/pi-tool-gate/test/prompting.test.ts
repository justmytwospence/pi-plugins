import { expect, test } from "vitest";
import { effectiveDenyInsteadOfPrompting, PROMPTING_CONTINUE, PROMPTING_DISABLED, PROMPTING_ENTRY, PROMPTING_STATUS_KEY, promptingDenied, restorePromptingOverride } from "../src/prompting.ts";
import { blockedBy, declinedMessage } from "../src/index.ts";

const entry = (denyInsteadOfPrompting: unknown, version: unknown = 1) => ({ type: "custom", customType: PROMPTING_ENTRY, data: { version, denyInsteadOfPrompting } });

test("prompting records and status use the public contract", () => {
  expect(PROMPTING_ENTRY).toBe("tool-gate:prompting");
  expect(PROMPTING_STATUS_KEY).toBe("permission-prompting");
});

test("absent, true, false and reset overrides fold in branch order", () => {
  expect(restorePromptingOverride([])).toBeUndefined();
  expect(restorePromptingOverride([entry(true)])).toBe(true);
  expect(restorePromptingOverride([entry(true), entry(false)])).toBe(false);
  expect(restorePromptingOverride([entry(false), entry(true)])).toBe(true);
  expect(restorePromptingOverride([entry(true), entry(null)])).toBeUndefined();
  expect(restorePromptingOverride([entry(null), entry(false)])).toBe(false);
});

test.each([undefined, null, false, 1, "bad", {}, [], { type: "custom", customType: PROMPTING_ENTRY },
  { type: "custom", customType: "other", data: { version: 1, denyInsteadOfPrompting: false } },
  { type: "message", customType: PROMPTING_ENTRY, data: { version: 1, denyInsteadOfPrompting: false } },
  entry("false"), entry(0), entry(undefined), entry(false, 2), entry(null, "1"), entry(null, 2),
])("malformed or unsupported record %j does not erase a valid override", invalid => {
  expect(restorePromptingOverride([invalid])).toBeUndefined();
  expect(restorePromptingOverride([entry(true), invalid])).toBe(true);
  expect(restorePromptingOverride([entry(false), invalid])).toBe(false);
});

test("precedence uses presence, not truthiness, and reset returns to fallback", () => {
  for (const configured of [true, false]) for (const inherited of [true, false, undefined]) {
    expect(effectiveDenyInsteadOfPrompting(true, inherited, configured)).toBe(true);
    expect(effectiveDenyInsteadOfPrompting(false, inherited, configured)).toBe(false);
    expect(effectiveDenyInsteadOfPrompting(undefined, inherited, configured)).toBe(inherited ?? configured);
    expect(effectiveDenyInsteadOfPrompting(restorePromptingOverride([entry(true), entry(null)]), inherited, configured)).toBe(inherited ?? configured);
  }
});

test.each([undefined, "outside project directories"])("refusal keeps gate attribution and held context (%s), without terminating or claiming a decline", held => {
  const result = promptingDenied("bash", held);
  expect(result).toEqual({ block: true, reason: [
    "tool-gate held this bash call: approval is required.", ...(held ? [held] : []), PROMPTING_DISABLED, PROMPTING_CONTINUE,
  ].join("\n") });
  expect(result).not.toHaveProperty("terminate");
  expect(result.reason).not.toMatch(/user declined|make your case|ask them to approve/iu);
  const error = { isError: true, content: [{ type: "text", text: result.reason }] };
  expect(blockedBy(error)).toBe("gate");
  expect(declinedMessage(error)).toBeUndefined();
});
