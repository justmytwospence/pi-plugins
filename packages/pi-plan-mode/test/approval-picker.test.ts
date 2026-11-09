import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import {
  APPROVAL_HINT,
  APPROVAL_QUESTION,
  type ApprovalInput,
  ApprovalPicker,
  type ApprovalResult,
  COMPACT_HERE,
  createApprovalState,
  EDIT,
  HERE,
  KEEP,
  pickApproval,
  SAVE,
} from "../src/approval-picker.js";
import type { ModelSpec, ModelSpecThinkingLevel } from "../src/implementation-models.js";

const planner: ModelSpec = { provider: "test", modelId: "planner", thinkingLevel: "high" };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = getKeybindings();
const supported: Array<ModelSpecThinkingLevel | undefined> = [undefined, "low", "medium", "high"];
const input: ApprovalInput = { planning: planner };
const down = "\x1b[B";
const up = "\x1b[A";
const right = "\x1b[C";
const left = "\x1b[D";

function fixture(
  options: {
    input?: ApprovalInput;
    state?: ReturnType<typeof createApprovalState>;
    efforts?: (spec: ModelSpec) => Array<ModelSpecThinkingLevel | undefined>;
    signal?: AbortSignal;
  } = {},
) {
  const state = options.state ?? createApprovalState();
  const done = vi.fn<(result: ApprovalResult | undefined) => void>();
  const requestRender = vi.fn();
  const component = new ApprovalPicker(
    options.input ?? input,
    state,
    { efforts: options.efforts ?? (() => supported) },
    theme,
    keys,
    requestRender,
    done,
    options.signal,
  );
  return { component, state, done, requestRender };
}

function rpcContext(select: ExtensionContext["ui"]["select"], overrides: Partial<ExtensionContext> = {}) {
  return {
    hasUI: true,
    mode: "rpc",
    model: { provider: "test", id: "planner" },
    thinkingLevel: "high",
    modelRegistry: {
      getAvailable: () => [{ provider: "test", id: "planner", reasoning: true }],
    },
    ui: { select, theme },
    ...overrides,
  } as unknown as ExtensionContext;
}

function tuiContext(run: (component: ApprovalPicker) => void, overrides: Partial<ExtensionContext> = {}) {
  const ctx = rpcContext(vi.fn(), { mode: "tui", ...overrides });
  ctx.ui.custom = (async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
    let component: ApprovalPicker | undefined;
    try {
      return await new Promise((resolve) => {
        component = factory({ requestRender() {} } as never, theme, keys as never, (result) =>
          resolve(result as never),
        ) as ApprovalPicker;
        run(component);
      });
    } finally {
      component?.dispose();
    }
  }) as ExtensionContext["ui"]["custom"];
  return ctx;
}

test("approval has exactly five rows and no handoff or context rows", () => {
  for (const width of [46, 120, 180]) {
    const { component } = fixture();
    const lines = component.render(width).map(stripVTControlCharacters);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
    assert.deepEqual(
      lines.filter((line) => /^ [→ ] \S/u.test(line)).map((line) => line.trim()),
      [`→ ${HERE}`, COMPACT_HERE, EDIT, SAVE, KEEP],
    );
    component.dispose();
  }
  const labels = [HERE, COMPACT_HERE, EDIT, SAVE, KEEP];
  assert.ok(labels.every((label) => !/hand off|Linked|Context|Fresh/iu.test(label)));
});

test("the optional note follows the question, sanitized, and is absent without it", () => {
  const plain = fixture();
  assert.ok(plain.component.render(120).join("\n").includes(` ${APPROVAL_QUESTION} ←/→ effort: high`));
  plain.component.dispose();
  const note = "Sonnet implements; Opus answers its questions.";
  const noted = fixture({ input: { ...input, note: `${note}\x1b[31m\n` } });
  for (const width of [46, 120]) {
    const rendered = noted.component
      .render(width)
      .map((line) => stripVTControlCharacters(line).trim())
      .join(" ");
    assert.ok(rendered.includes(`${APPROVAL_QUESTION} ${note}`), rendered);
    assert.ok(!rendered.includes("\x1b"));
  }
  noted.component.dispose();
});

test("note appears in the RPC question", async () => {
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(KEEP);
  await pickApproval(rpcContext(select), { note: "Worker implements; Planner answers." }, createApprovalState());
  assert.equal(select.mock.calls[0]?.[0], `${APPROVAL_QUESTION} Worker implements; Planner answers.`);
});

test("RPC nonexecution choices never request effort", async () => {
  for (const [label, kind] of [
    [EDIT, "edit"],
    [SAVE, "save"],
    [KEEP, "keep"],
  ] as const) {
    const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(label);
    assert.deepEqual(await pickApproval(rpcContext(select), input, createApprovalState()), {
      effortSource: "fallback",
      choice: { kind },
    });
    assert.equal(select.mock.calls.length, 1);
  }
});

test("remote answers win only when they answer, and a remote Keep never changes the terminal selection", async () => {
  let terminal!: ApprovalPicker;
  let release!: (value: string | undefined) => void;
  const waiting = new Promise<string | undefined>((resolve) => {
    release = resolve;
  });
  const select = vi.fn().mockImplementationOnce(() => waiting);
  const ctx = tuiContext((component) => {
    terminal = component;
  });
  const state = createApprovalState();
  const result = pickApproval(ctx, input, state, undefined, { select } as never);
  await vi.waitFor(() => assert.equal(select.mock.calls.length, 1));
  assert.equal(state.selectedId, "here");
  terminal.handleInput(down);
  terminal.handleInput("\r");
  const approved = await result;
  assert.equal(approved?.remote, false);
  assert.equal(approved?.choice.kind, "compact-here");
  release(undefined);

  const remoteSelect = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(KEEP);
  const remoteResult = await pickApproval(
    tuiContext(() => {}),
    input,
    createApprovalState(),
    undefined,
    { select: remoteSelect } as never,
  );
  assert.equal(remoteResult?.remote, true);
  assert.equal(remoteResult?.choice.kind, "keep");
});

test("direct implementation is first/default and selection uses the Pi bindings", () => {
  const first = fixture();
  first.component.handleInput("\r");
  assert.deepEqual(first.done.mock.calls, [
    [{ effortSource: "fallback", choice: { kind: "here" }, thinkingLevel: "high" }],
  ]);
  first.component.handleInput(down);
  first.component.handleInput("\r");
  assert.equal(first.done.mock.calls.length, 1);

  const compact = fixture();
  compact.component.handleInput(down);
  compact.component.handleInput("\r");
  assert.deepEqual(compact.done.mock.calls, [
    [{ effortSource: "fallback", choice: { kind: "compact-here" }, thinkingLevel: "high" }],
  ]);
  assert.equal(compact.requestRender.mock.calls.length, 1);

  const edit = fixture();
  edit.component.handleInput(down);
  edit.component.handleInput(down);
  edit.component.handleInput("\r");
  assert.deepEqual(edit.done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "edit" } }]]);

  const keep = fixture();
  keep.component.handleInput(up);
  keep.component.handleInput("\r");
  assert.deepEqual(keep.done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "keep" } }]]);
});

test("Save for later is between Edit and Keep and ignores effort keys", () => {
  const { component, state, done, requestRender } = fixture();
  component.handleInput(up); // Keep
  component.handleInput(up); // Save
  assert.equal(state.selectedId, "save");
  const before = component.render(120);
  const efforts = new Map(state.efforts);
  const renders = requestRender.mock.calls.length;
  assert.ok(before.join("\n").includes(`→ ${SAVE}`));
  component.handleInput(left);
  component.handleInput(right);
  assert.deepEqual(component.render(120), before);
  assert.deepEqual(state.efforts, efforts);
  assert.equal(requestRender.mock.calls.length, renders);
  component.handleInput(up);
  assert.equal(state.selectedId, "edit");
  component.handleInput(down);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "save" } }]]);
});

test("left/right cycle only supported efforts; both direct rows share effort", () => {
  const { component, state, requestRender, done } = fixture();
  component.handleInput(right); // high -> low, no registry-default pseudo-level
  assert.match(component.render(120).join("\n"), /←\/→ effort: low/u);
  component.handleInput(down);
  assert.match(component.render(120).join("\n"), /←\/→ effort: low/u);
  component.handleInput(left);
  assert.match(component.render(120).join("\n"), /←\/→ effort: high/u);
  component.handleInput(left);
  component.handleInput(left);
  assert.match(component.render(120).join("\n"), /←\/→ effort: low/u);
  component.handleInput(right);
  component.handleInput(up);
  assert.match(component.render(120).join("\n"), /←\/→ effort: medium/u);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [[{ effortSource: "manual", choice: { kind: "here" }, thinkingLevel: "medium" }]]);
  assert.equal(state.efforts.get(JSON.stringify(["test", "planner"])), "medium");
  assert.equal(requestRender.mock.calls.length, 7);
});

test("selection and effort survive Edit", () => {
  const state = createApprovalState();
  const first = fixture({ state });
  first.component.handleInput(left); // high -> medium
  first.component.handleInput(down);
  first.component.handleInput(down);
  first.component.handleInput("\r");
  assert.deepEqual(first.done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "edit" } }]]);

  const second = fixture({ state });
  assert.equal(state.selectedId, "edit");
  assert.match(second.component.render(120).join("\n"), /Select an implementation choice to adjust effort/u);
  second.component.handleInput(up);
  assert.equal(state.selectedId, "compact-here");
  assert.match(second.component.render(120).join("\n"), /effort: medium/u);
  second.component.handleInput("\r");
  assert.deepEqual(second.done.mock.calls, [
    [{ effortSource: "manual", choice: { kind: "compact-here" }, thinkingLevel: "medium" }],
  ]);
});

test("effort defaults to the planning level, normalized down; unset stays the registry default", () => {
  const cases: [ModelSpecThinkingLevel | undefined, ModelSpecThinkingLevel | undefined][] = [
    ["max", "high"],
    ["low", "low"],
    ["xhigh", "high"],
    [undefined, undefined],
    ["off", "low"],
  ];
  for (const [level, expected] of cases) {
    const { component, done } = fixture({ input: { planning: { ...planner, thinkingLevel: level } } });
    for (const width of [46, 120]) {
      assert.ok(
        component
          .render(width)
          .join("\n")
          .includes(`←/→ effort: ${expected ?? "default"}`),
      );
    }
    component.handleInput("\r");
    assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, expected);
  }
});

test("nonreasoning models have no effort control or returned level", () => {
  const { component, done, requestRender } = fixture({ efforts: () => [undefined] });
  assert.match(component.render(46).join("\n"), /Effort: not supported/u);
  component.handleInput(right);
  component.handleInput(left);
  assert.equal(requestRender.mock.calls.length, 0);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "here" } }]]);
});

test("registry-default direct effort is retained until explicitly changed", () => {
  const { component, done } = fixture({ input: { ...input, planning: { ...planner, thinkingLevel: undefined } } });
  assert.match(component.render(120).join("\n"), /effort: default/u);
  component.handleInput(left);
  component.handleInput("\r");
  assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, "high");
});

test("abort, escape and Ctrl+C complete once and release abort listeners", () => {
  for (const action of ["abort", "\x1b", "\x03", "\r", "dispose"] as const) {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { component, done } = fixture({ signal: controller.signal });
    if (action === "abort") controller.abort();
    else if (action === "dispose") component.dispose();
    else component.handleInput(action);
    assert.equal(add.mock.calls[0]?.[0], "abort");
    assert.equal(remove.mock.calls[0]?.[0], "abort");
    assert.equal(remove.mock.calls[0]?.[1], add.mock.calls[0]?.[1]);
    controller.abort();
    assert.equal(done.mock.calls.length, action === "dispose" ? 0 : 1);
    if (action !== "\r" && action !== "dispose") assert.equal(done.mock.calls[0]?.[0], undefined);
  }
  const controller = new AbortController();
  controller.abort();
  const { done } = fixture({ signal: controller.signal });
  assert.deepEqual(done.mock.calls, [[undefined]]);
});

test("standard Pi layout at 46 and 120 columns, with and without a note, and effort changes", () => {
  for (const width of [46, 120]) {
    const { component } = fixture();
    for (const changed of [false, true]) {
      if (changed) component.handleInput(left);
      const rendered = component.render(width).map(stripVTControlCharacters);
      assert.ok(rendered.every((line) => visibleWidth(line) === width));
      const lines = rendered.map((line) => line.trimEnd());
      assert.equal(lines[0], "─".repeat(width));
      assert.equal(lines.at(-1), "─".repeat(width));
      assert.equal(lines[1], "");
      assert.equal(lines[2], ` ${APPROVAL_QUESTION} ←/→ effort: ${changed ? "medium" : "high"}`);
      assert.equal(lines[3], "");
      assert.equal(lines[4], ` → ${HERE}`);
      assert.equal(lines[5], `   ${COMPACT_HERE}`);
      assert.equal(lines[6], `   ${EDIT}`);
      assert.equal(lines[7], `   ${SAVE}`);
      assert.equal(lines[8], `   ${KEEP}`);
      assert.equal(lines[9], "");
      assert.equal(
        lines
          .slice(10, -2)
          .map((line) => line.trim())
          .join(" "),
        APPROVAL_HINT,
      );
      assert.equal(lines.at(-2), "");
      assert.equal(lines.length, width === 46 ? 14 : 13);
    }
    component.dispose();
  }
  for (const width of [46, 120]) {
    const { component } = fixture({ input: { ...input, note: "Worker implements; Planner answers." } });
    const rendered = component.render(width).map(stripVTControlCharacters);
    assert.ok(rendered.every((line) => visibleWidth(line) === width));
    assert.ok(rendered.some((line) => line.includes("Worker")));
    component.dispose();
  }
});

test("unhandled viewport scrolling keys do not change selection, effort or render", () => {
  const { component, requestRender, state } = fixture();
  const before = component.render(46);
  component.handleInput("\x15");
  component.handleInput("\x04");
  assert.equal(state.selectedId, "here");
  assert.deepEqual(component.render(46), before);
  assert.equal(requestRender.mock.calls.length, 0);
  component.dispose();
});

test("pickApproval uses one TUI component, current session effort, and cleans up on failure", async () => {
  const state = createApprovalState();
  const ctx = tuiContext((component) => {
    component.handleInput(left);
    component.handleInput(down);
    component.handleInput("\r");
  });
  const result = await pickApproval(ctx, {}, state);
  assert.deepEqual(result, { effortSource: "manual", choice: { kind: "compact-here" }, thinkingLevel: "medium" });
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const broken = tuiContext(() => {
    throw new Error("render failed");
  });
  await assert.rejects(pickApproval(broken, input, createApprovalState(), controller.signal), /render failed/u);
  assert.ok(remove.mock.calls.length > 0);
});

test("RPC selects the action then supported effort; action cancellation declines", async () => {
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(HERE).mockResolvedValueOnce("low");
  const result = await pickApproval(rpcContext(select), input, createApprovalState());
  assert.deepEqual(result, { effortSource: "manual", choice: { kind: "here" }, thinkingLevel: "low" });
  assert.deepEqual(select.mock.calls[0]?.slice(0, 2), [APPROVAL_QUESTION, [HERE, COMPACT_HERE, EDIT, SAVE, KEEP]]);
  assert.deepEqual(select.mock.calls[1]?.[1], ["high", "off", "minimal", "low", "medium"]);
  for (const answers of [[undefined], [COMPACT_HERE, undefined, undefined]]) {
    const cancel = vi.fn<ExtensionContext["ui"]["select"]>();
    for (const answer of answers) cancel.mockResolvedValueOnce(answer);
    assert.equal(await pickApproval(rpcContext(cancel), input, createApprovalState()), undefined);
    assert.equal(cancel.mock.calls.length, answers.length);
  }
});

test("RPC effort cancellation returns to the retained action and preserves the effort", async () => {
  const state = createApprovalState();
  state.efforts.set(JSON.stringify(["test", "planner"]), "low");
  const answers = [COMPACT_HERE, undefined, COMPACT_HERE, "medium"];
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockImplementation(async () => answers.shift());
  assert.deepEqual(await pickApproval(rpcContext(select), input, state), {
    effortSource: "manual",
    choice: { kind: "compact-here" },
    thinkingLevel: "medium",
  });
  assert.deepEqual(
    select.mock.calls.map(([title]) => title),
    [APPROVAL_QUESTION, "Implementation effort", APPROVAL_QUESTION, "Implementation effort"],
  );
  assert.equal(select.mock.calls[2]?.[1][0], COMPACT_HERE);
  assert.deepEqual(
    [1, 3].map((index) => select.mock.calls[index]?.[1][0]),
    ["low", "low"],
  );
  assert.equal(state.selectedId, "compact-here");
});

for (const stage of ["action", "effort", "back"] as const) {
  test(`RPC signal abort during ${stage} exits without reopening or approving`, async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const select = vi.fn<ExtensionContext["ui"]["select"]>().mockImplementation(async (_title, _choices, options) => {
      assert.equal(options?.signal, controller.signal);
      const call = select.mock.calls.length;
      if (stage !== "action" && call === 1) return COMPACT_HERE;
      if (stage === "back" && call === 2) return undefined;
      controller.abort();
      return undefined;
    });
    assert.equal(await pickApproval(rpcContext(select), input, createApprovalState(), controller.signal), undefined);
    assert.equal(select.mock.calls.length, stage === "action" ? 1 : stage === "effort" ? 2 : 3);
    assert.ok(remove.mock.calls.some(([event]) => event === "abort"));
  });
}

test("RPC Save for later returns without an effort dialog for reasoning models", async () => {
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(SAVE);
  const state = createApprovalState();
  assert.deepEqual(await pickApproval(rpcContext(select), input, state), {
    effortSource: "fallback",
    choice: { kind: "save" },
  });
  assert.equal(state.selectedId, "save");
  assert.equal(select.mock.calls.length, 1);
});

test("RPC handles nonexecution and nonreasoning choices without another selector", async () => {
  for (const label of [EDIT, KEEP, HERE]) {
    const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(label);
    const ctx = rpcContext(select, { modelRegistry: { getAvailable: () => [], find: () => undefined } as never });
    const result = await pickApproval(ctx, input, createApprovalState());
    assert.deepEqual(result, {
      effortSource: "fallback",
      choice: { kind: label === EDIT ? "edit" : label === KEEP ? "keep" : "here" },
    });
    assert.equal(select.mock.calls.length, 1);
  }
});

test("catalog registry fallback supplies the current model's supported effort outside the available list", async () => {
  const find = vi.fn(() => ({ provider: "test", id: "planner", reasoning: true, thinkingLevelMap: { high: null } }));
  const ctx = tuiContext((component) => component.handleInput("\r"), {
    modelRegistry: { getAvailable: () => [], find } as never,
  });
  assert.deepEqual(await pickApproval(ctx, {}, createApprovalState()), {
    effortSource: "fallback",
    choice: { kind: "here" },
    thinkingLevel: "medium",
  });
  assert.ok(find.mock.calls.length > 0);
});

test("RPC puts the normalized effort first so Enter retains the default", async () => {
  const select = vi
    .fn<ExtensionContext["ui"]["select"]>()
    .mockImplementationOnce(async (_question, options) => options[1])
    .mockImplementationOnce(async (_question, options) => {
      assert.equal(options[0], "high");
      return options[0];
    });
  assert.deepEqual(await pickApproval(rpcContext(select), input, createApprovalState()), {
    effortSource: "fallback",
    choice: { kind: "compact-here" },
    thinkingLevel: "high",
  });
});

test("recommendations initialize the direct rows and normalize, including inherited off", () => {
  const direct = fixture({ input: { ...input, recommendedThinkingLevel: "low" } });
  direct.component.handleInput("\r");
  assert.deepEqual(direct.done.mock.calls[0]?.[0], {
    choice: { kind: "here" },
    thinkingLevel: "low",
    effortSource: "system1",
  });
  for (const inherited of ["high", "off"] as const) {
    const { component, done } = fixture({
      input: {
        ...input,
        planning: { ...planner, thinkingLevel: inherited },
        recommendedThinkingLevel: "xhigh",
        effortDefaultKey: "a",
      },
    });
    assert.match(component.render(120).join("\n"), /effort: high/u);
    component.handleInput(down);
    component.handleInput("\r");
    assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, "high");
  }
  const nonreasoning = fixture({ input: { ...input, recommendedThinkingLevel: "high" }, efforts: () => [undefined] });
  nonreasoning.component.handleInput("\r");
  assert.equal(nonreasoning.done.mock.calls[0]?.[0]?.thinkingLevel, undefined);
});

test("a per-model recommendation beats the generic one", () => {
  const { component, done } = fixture({
    input: {
      ...input,
      recommendedThinkingLevel: "high",
      recommendations: new Map([["test/planner", "low" as const]]),
    },
  });
  component.handleInput("\r");
  assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, "low");
  assert.equal(done.mock.calls[0]?.[0]?.effortSource, "system1");
});

test("revised recommendation replaces only automatic defaults while manual edits and action survive", () => {
  const automatic = createApprovalState();
  const a = fixture({
    state: automatic,
    input: { ...input, recommendedThinkingLevel: "low", effortDefaultKey: "first" },
  });
  assert.equal(automatic.efforts.get(JSON.stringify(["test", "planner"])), "low");
  a.component.dispose();
  const b = fixture({
    state: automatic,
    input: { ...input, recommendedThinkingLevel: "high", effortDefaultKey: "second" },
  });
  assert.equal(automatic.efforts.get(JSON.stringify(["test", "planner"])), "high");
  b.component.dispose();

  const state = createApprovalState();
  const first = fixture({ state, input: { ...input, recommendedThinkingLevel: "low", effortDefaultKey: "first" } });
  first.component.handleInput(right); // low -> medium
  first.component.handleInput(up); // keep
  first.component.handleInput(up); // save
  first.component.handleInput(up); // edit
  first.component.handleInput("\r");
  const next = fixture({ state, input: { ...input, recommendedThinkingLevel: "high", effortDefaultKey: "second" } });
  assert.equal(state.selectedId, "edit");
  assert.equal(state.efforts.get(JSON.stringify(["test", "planner"])), "medium");
  next.component.dispose();
});

test("RPC offers recommended effort first and retains explicit selection across keys", async () => {
  const state = createApprovalState();
  const select = vi
    .fn<ExtensionContext["ui"]["select"]>()
    .mockResolvedValueOnce(HERE)
    .mockImplementationOnce(async (_question, options) => {
      assert.equal(options[0], "low");
      return "medium";
    });
  assert.equal(
    (
      await pickApproval(
        rpcContext(select),
        { ...input, recommendedThinkingLevel: "low", effortDefaultKey: "a" },
        state,
      )
    )?.thinkingLevel,
    "medium",
  );
  const next = fixture({ state, input: { ...input, recommendedThinkingLevel: "high", effortDefaultKey: "b" } });
  assert.match(next.component.render(120).join("\n"), /effort: medium/u);
});

test("no UI and pre-aborted signals never open a dialog; abort propagates to RPC selects", async () => {
  const select = vi.fn<ExtensionContext["ui"]["select"]>();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await pickApproval(rpcContext(select), input, createApprovalState(), controller.signal), undefined);
  assert.equal(await pickApproval(rpcContext(select, { hasUI: false }), input, createApprovalState()), undefined);
  assert.equal(select.mock.calls.length, 0);
  const active = new AbortController();
  const abortSelect = vi
    .fn<ExtensionContext["ui"]["select"]>()
    .mockImplementationOnce(async (_question, _options, options) => {
      assert.equal(options?.signal, active.signal);
      active.abort();
      return HERE;
    });
  assert.equal(await pickApproval(rpcContext(abortSelect), input, createApprovalState(), active.signal), undefined);
  assert.equal(abortSelect.mock.calls.length, 1);
});
