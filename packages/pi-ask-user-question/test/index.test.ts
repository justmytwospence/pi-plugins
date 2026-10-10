import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import askUserQuestion, { blockedLabel } from "../src/index.ts";
import { DECLINED } from "../src/result.ts";
import { harness, KEYS, plainTheme, q, tuiContext } from "./harness.ts";

const params = {
  questions: [
    { question: "Which date library?", header: "Library", options: [{ label: "date-fns", description: "Tree-shakeable" }, { label: "dayjs", description: "Small" }] },
  ],
};

function setup() {
  const h = harness();
  askUserQuestion(h.pi);
  return h;
}

const run = (h: ReturnType<typeof setup>, args: unknown, ctx: unknown, signal?: AbortSignal) =>
  h.tool.execute("call-1", args, signal, undefined, ctx);

test("registers ask_user_question with Claude Code's schema and pi's prompt hooks", () => {
  const h = setup();
  expect(h.tool).toMatchObject({ name: "ask_user_question", label: "Ask user", executionMode: "sequential" });
  expect(h.tool.description).toMatch(/Type something\./u);
  expect(h.tool.description).toMatch(/Preview feature:/u);
  expect(h.tool.promptSnippet).toMatch(/up to 4/u);
  expect(h.tool.promptGuidelines.join("\n")).toMatch(/\(Recommended\)/u);
  const question = h.tool.parameters.properties.questions.items.properties;
  expect(Object.keys(question)).toEqual(["question", "header", "options", "multiSelect"]);
});

describe("herdr", () => {
  test("the open dialog holds herdr:blocked; the answer comes back as Claude Code's text", async () => {
    const h = setup();
    const result = await run(h, params, tuiContext([KEYS.down, KEYS.enter], { events: h.events }));
    expect(result.content[0].text).toBe(
      `User has answered your questions: "Which date library?"="dayjs". You can now continue with the user's answers in mind.`,
    );
    expect(h.events).toEqual([
      { channel: "herdr:blocked", data: { active: true, label: "Library" } },
      { channel: "ui.custom", data: undefined },
      { channel: "herdr:blocked", data: { active: false } },
    ]);
  });

  test("released after a decline", async () => {
    const h = setup();
    const result = await run(h, params, tuiContext([KEYS.esc], { events: h.events }));
    expect(result.content[0].text).toBe(DECLINED);
    expect(result.details).toMatchObject({ cancelled: true, answers: [] });
    expect(h.events.map((e) => e.data?.active)).toEqual([true, undefined, false]);
  });

  test("released when the dialogs throw", async () => {
    const h = setup();
    const ctx: any = tuiContext([]);
    ctx.ui.custom = async () => {
      throw new Error("no terminal");
    };
    ctx.ui.select = async () => {
      throw new Error("no dialog either");
    };
    await expect(run(h, params, ctx)).rejects.toThrow(/no dialog either/u);
    expect(h.events.map((e) => e.data)).toEqual([{ active: true, label: "Library" }, { active: false }]);
  });

  test("a throwing listener does not break the tool", async () => {
    const h = setup();
    h.pi.events.emit = () => {
      throw new Error("listener");
    };
    const result = await run(h, params, tuiContext([KEYS.enter]));
    expect(result.details.answers[0].answer).toBe("date-fns");
  });

  test("the label is the headers, cut to 60 characters", () => {
    expect(blockedLabel([q("A?", "Library", ["x", "y"]), q("B?", "Features", ["x", "y"])])).toBe("Library · Features");
    expect(blockedLabel([q("What should the very long question say here?", "", ["x", "y"]), q("B?", "Another header", ["x", "y"])])).toHaveLength(60);
  });

  test("invalid questions and a missing UI never hold it", async () => {
    const h = setup();
    const invalid = await run(h, { questions: [{ question: "Q?", header: "H", options: [{ label: "Other", description: "" }, { label: "x", description: "" }] }] }, tuiContext([]));
    expect(invalid.details.error).toBe("reserved_label");
    expect(invalid.content[0].text).toMatch(/^Error: /u);
    const headless = await run(h, params, { mode: "print", hasUI: false, ui: {} });
    expect(headless.details.error).toBe("no_ui");
    expect(h.events).toEqual([]);
  });
});

test("RPC hosts get native dialogs", async () => {
  const h = setup();
  const selects: any[] = [];
  const ctx = {
    mode: "rpc",
    hasUI: true,
    ui: {
      custom: async () => {
        throw new Error("not in rpc");
      },
      select: async (title: string, options: string[]) => {
        selects.push({ title, options });
        return options[1];
      },
      input: async () => undefined,
    },
  };
  const result = await run(h, params, ctx);
  expect(selects[0]).toEqual({ title: "[Library] Which date library?", options: ["1. date-fns - Tree-shakeable", "2. dayjs - Small", "3. Type something."] });
  expect(result.details.answers[0]).toMatchObject({ kind: "option", answer: "dayjs" });
  expect(h.events.map((e) => e.data.active)).toEqual([true, false]);
});

describe("reconcile", () => {
  test("withdrawn without a UI, restored with one, other tools untouched", async () => {
    const h = setup();
    await h.emit("before_agent_start", {}, { hasUI: false });
    expect(h.active).toEqual(["read", "bash"]);
    await h.emit("before_agent_start", {}, { hasUI: false });
    expect(h.active).toEqual(["read", "bash"]);
    await h.emit("before_agent_start", {}, { hasUI: true });
    expect(h.active).toEqual(["read", "bash", "ask_user_question"]);
  });

  test("a removal made elsewhere is left alone", async () => {
    const h = setup();
    h.pi.setActiveTools(["read"]);
    await h.emit("before_agent_start", {}, { hasUI: true });
    expect(h.active).toEqual(["read"]);
  });
});

describe("transcript", () => {
  const render = (component: any) => component.render(120).map((line: string) => stripTerminalSequences(line).trimEnd()).join("\n");

  test("the call shows the headers", () => {
    const h = setup();
    expect(render(h.tool.renderCall({ questions: [{ header: "Library" }, { header: "Features" }] }, plainTheme, {}))).toBe(
      "ask_user_question Library · Features",
    );
    expect(render(h.tool.renderCall({}, plainTheme, {}))).toBe("ask_user_question");
  });

  test("the result: one line per answer, Unanswered, Declined", () => {
    const h = setup();
    const details = {
      questions: [],
      cancelled: false,
      answers: [
        { index: 0, header: "Library", question: "Which?", kind: "option", answer: "dayjs", notes: "small\nbundle" },
        { index: 1, header: "Name", question: "Name?", kind: "custom", answer: "Temporal" },
        { index: 2, header: "Target", question: "Where?", kind: "unanswered", answer: null },
      ],
    };
    expect(render(h.tool.renderResult({ content: [], details }, {}, plainTheme, {}))).toBe(
      "✓ Library: dayjs · note: small bundle\n✓ Name: (wrote) Temporal\n- Target: Unanswered",
    );
    expect(render(h.tool.renderResult({ content: [], details: { ...details, cancelled: true } }, {}, plainTheme, {}))).toBe("Declined");
    expect(
      render(h.tool.renderResult({ content: [{ type: "text", text: "Error: x" }], details: { ...details, error: "no_ui" } }, {}, plainTheme, {})),
    ).toBe("Error: x");
  });
});
