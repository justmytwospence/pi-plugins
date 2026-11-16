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
  for (const guidance of [h.tool.description, h.tool.promptGuidelines.join("\n")]) {
    expect(guidance).toContain("missing requirements and consequential user preferences, not permission to perform an already requested task or routine steps within its scope");
    expect(guidance).toContain("Choose reasonable implementation details without asking.");
    expect(guidance).toContain("Do not use this tool as a substitute approval gate");
    expect(guidance).toContain("follow the active workflow and approval policy, and leave tool permission decisions to the host");
    expect(guidance).toContain("A genuine unresolved requirement may still need clarification in yolo mode.");
    expect(guidance).toContain("guessing would be costly");
    expect(guidance).toContain("do not ask about things you can find out yourself");
  }
  const question = h.tool.parameters.properties.questions.items.properties;
  expect(Object.keys(question)).toEqual(["question", "header", "options", "multiSelect", "showIf"]);
});

describe("herdr", () => {
  test("the open dialog holds herdr:blocked; the answer comes back as Claude Code's text", async () => {
    const h = setup();
    const result = await run(h, params, tuiContext([KEYS.down, KEYS.enter], { events: h.events }));
    expect(result.content[0].text).toBe(
      `User has answered your questions: "Which date library?"="dayjs". You can now continue with the user's answers in mind.`,
    );
    expect(h.events.filter((e) => !["pi-plugins.editor-factory.v1", "switchyard.remote-ui.v1"].includes(e.channel))).toEqual([
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
    expect(h.events.filter((e) => !["pi-plugins.editor-factory.v1", "switchyard.remote-ui.v1"].includes(e.channel)).map((e) => e.data?.active)).toEqual([true, undefined, false]);
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
    expect(h.events.filter((e) => e.channel !== "switchyard.remote-ui.v1").map((e) => e.data)).toEqual([{ active: true, label: "Library" }, { active: false }]);
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
      " ? Question · Library · Features",
    );
    expect(render(h.tool.renderCall({}, plainTheme, {}))).toBe(" ? Question");
  });

  const ans = (o: any) => ({ index: 0, question: "Q?", kind: "option", ...o });
  const result = (h: any, details: any, opts: any = {}, ctx: any = {}, content: any[] = []) =>
    render(h.tool.renderResult({ content, details }, opts, plainTheme, ctx));

  test("the call row steps aside once the result is shown", () => {
    const h = setup();
    const ctx = { state: {} };
    const args = { questions: [{ header: "Library" }] };
    expect(render(h.tool.renderCall(args, plainTheme, ctx))).toBe(" ? Question · Library");
    result(h, { questions: [], cancelled: false, answers: [ans({ header: "Library", answer: "x" })] }, {}, ctx);
    expect(render(h.tool.renderCall(args, plainTheme, ctx))).toBe("");
    expect(render(h.tool.renderCall(args, plainTheme, { state: { answered: true } }))).toBe("");
  });

  test("the result card: header, question, answers, notes", () => {
    const h = setup();
    const details = {
      questions: [],
      cancelled: false,
      note: "ship it",
      answers: [
        ans({ header: "Library", question: "Which date library?", answer: "dayjs", notes: "small\nbundle" }),
        ans({ header: "Name", question: "Name?", kind: "custom", answer: "Temporal" }),
        ans({ header: "Features", question: "Which features?", kind: "multi", answer: "a, b", selected: ["a", "b"] }),
        ans({ header: "Target", question: "Where?", kind: "unanswered", answer: null }),
        ans({ header: "Hidden", question: "Skipped?", kind: "skipped", answer: null }),
      ],
    };
    const out = result(h, details, { expanded: true });
    for (const line of ["Library", "Which date library?", "› dayjs", "note: small", "› wrote: Temporal", "› a", "› b", "› Unanswered", "Note: ship it"]) {
      expect(out).toContain(line);
    }
    expect(out).toContain("✓ Questions · 3/4 answered");
    expect(out).not.toContain("Hidden");
  });

  test("a header equal to the question is not repeated", () => {
    const h = setup();
    const out = result(h, { questions: [], cancelled: false, answers: [ans({ header: "", question: "Proceed?", answer: "Yes" })] });
    expect(out.split("\n").filter((l: string) => l.includes("Proceed?"))).toHaveLength(1);
  });

  test("previews only when expanded", () => {
    const h = setup();
    const details = { questions: [], cancelled: false, answers: [ans({ header: "H", answer: "A", preview: "line one" })] };
    const collapsed = result(h, details);
    expect(collapsed).toContain("· preview");
    expect(collapsed).toContain("to expand");
    expect(collapsed).not.toContain("│ line one");
    expect(result(h, details, { expanded: true })).toContain("│ line one");
  });

  test("declined and errors are one row", () => {
    const h = setup();
    const details = { questions: [], cancelled: true, answers: [] };
    expect(result(h, details)).toBe(" ■ Question · Declined");
    expect(result(h, { ...details, error: "no_ui" }, {}, {}, [{ type: "text", text: "Error: x" }])).toBe(" ✗ Question · Error: x");
  });

  test("long cards fold", () => {
    const h = setup();
    const answers = Array.from({ length: 6 }, (_, i) => ans({ header: `H${i}`, answer: "A", notes: "n" }));
    const details = { questions: [], cancelled: false, answers };
    expect(result(h, details)).toContain("more lines");
    expect(result(h, details, { expanded: true })).not.toContain("more lines");
  });
});

test("offers its answers to pi-sticky-last-prompt over the user-words channel", () => {
  const h = setup();
  const registered: Array<[string, (call: unknown) => string | undefined]> = [];
  h.pi.events.emit("pi-plugins.user-words.v1", { version: 1, register: (name: string, extract: any) => registered.push([name, extract]) });
  expect(registered.map(([name]) => name)).toEqual(["ask_user_question"]);
  const details = { questions: [], answers: [{ index: 0, header: "H", question: "Q", kind: "custom", answer: "use rg" }], cancelled: false };
  expect(registered[0]![1]({ toolName: "ask_user_question", args: {}, result: { details } })).toBe("use rg");
});
