import { expect, test } from "vitest";
import { askWithDialogs, parseMulti } from "../src/rpc.ts";
import { q } from "./harness.ts";

const library = q("Which library?", "Library", ["date-fns", "dayjs"]);
library.options[0]!.preview = "format(d, 'yyyy')";
const features = q("Which features?", "Features", ["Auth", "Billing", "Search"], { multiSelect: true });

function ui(selects: Array<string | undefined>, inputs: Array<string | undefined>) {
  const calls: Array<{ kind: string; title: string; options?: string[] }> = [];
  return {
    calls,
    select: async (title: string, options: string[]) => {
      calls.push({ kind: "select", title, options });
      const answer = selects.shift();
      return answer === undefined ? undefined : (options.find((o) => o.startsWith(answer)) ?? answer);
    },
    input: async (title: string) => {
      calls.push({ kind: "input", title });
      return inputs.shift();
    },
  };
}

test("select and input answers map to the dialog's result shapes", async () => {
  const dialogs = ui(["1."], ["1,3"]);
  const result = await askWithDialogs(dialogs, [library, features]);
  expect(result.cancelled).toBe(false);
  expect(result.answers[0]).toMatchObject({ kind: "option", answer: "date-fns", preview: "format(d, 'yyyy')" });
  expect(result.answers[1]).toMatchObject({ kind: "multi", selected: ["Auth", "Search"] });
  expect(dialogs.calls[0]!.title).toMatch(/^\[Library\] Which library\?\n\n--- 1\. date-fns ---\nformat/u);
  expect(dialogs.calls[1]!.title).toMatch(/1\. Auth - Auth description\n2\. Billing/u);
});

test("Type something asks for text", async () => {
  const result = await askWithDialogs(ui(["3."], ["Temporal"]), [library]);
  expect(result.answers[0]).toMatchObject({ kind: "custom", answer: "Temporal" });
});

test("multi-select: numbers select, words are a typed answer", () => {
  expect(parseMulti(features, "1, 3")).toEqual({ kind: "multi", selected: ["Auth", "Search"] });
  expect(parseMulti(features, "3 1 3")).toEqual({ kind: "multi", selected: ["Auth", "Search"] });
  expect(parseMulti(features, "just auth")).toEqual({ kind: "custom", text: "just auth" });
  expect(parseMulti(features, "4")).toEqual({ kind: "custom", text: "4" });
});

test("dismissing any dialog declines, keeping earlier answers", async () => {
  const result = await askWithDialogs(ui(["2."], [undefined]), [library, features]);
  expect(result).toMatchObject({ cancelled: true, answers: [{ answer: "dayjs" }] });
  expect((await askWithDialogs(ui([undefined], []), [library])).cancelled).toBe(true);
});
