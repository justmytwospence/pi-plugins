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
  defaultImplementationContext,
  EDIT,
  HERE,
  IMPLEMENT,
  KEEP,
  pairLabel,
  pickApproval,
  SAVE,
  shortModelName,
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

const text = (component: ApprovalPicker, width = 120) =>
  component.render(width).map(stripVTControlCharacters).join("\n");
const rowsOf = (component: ApprovalPicker, width = 120) =>
  component
    .render(width)
    .map(stripVTControlCharacters)
    .filter((line) => /^ [→ ] \S/u.test(line))
    .map((line) => line.trim().replace(/^→ /u, ""));

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

test("approval has exactly four action rows; model, effort and context are not rows", () => {
  for (const width of [46, 120, 180]) {
    const { component } = fixture();
    const lines = component.render(width).map(stripVTControlCharacters);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
    assert.deepEqual(
      lines.filter((line) => /^ [→ ] \S/u.test(line)).map((line) => line.trim()),
      [`→ ${IMPLEMENT}`, EDIT, SAVE, KEEP],
    );
    component.dispose();
  }
});

test("an offered pair worker is a second model with independent, recommended effort", () => {
  const worker: ModelSpec = { provider: "test", modelId: "worker", thinkingLevel: "high" };
  const { component, state, done } = fixture({
    input: {
      planning: planner,
      alternate: { model: worker, name: "Claude Sonnet 5.5", kind: "pair-worker" },
      recommendations: new Map([["test/worker", "low"]]),
      note: "Opus 5.5 answers its questions",
    },
  });
  assert.deepEqual(rowsOf(component), [IMPLEMENT, EDIT, SAVE, KEEP]);
  assert.match(text(component), /Model: planner · tab\s*\n/u);
  assert.doesNotMatch(text(component), /Opus 5\.5 answers/u);
  assert.match(text(component), /Effort: high · ←\/→/u);
  assert.match(text(component), /Context: keep conversation · c/u);
  component.handleInput("\t");
  assert.match(text(component), /Model: Sonnet 5\.5 \(Opus 5\.5 answers its questions\) · tab/u);
  assert.match(text(component), /Effort: low/u);
  assert.match(text(component), /Context: compact to plan \(other model\)/u);
  component.handleInput(right);
  assert.match(text(component), /Effort: medium/u);
  component.handleInput("\t");
  assert.match(text(component), /Effort: high/u);
  assert.match(text(component), /Context: keep conversation/u);
  component.handleInput("\t");
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [
    [{ effortSource: "manual", choice: { kind: "compact-here", alternate: true }, thinkingLevel: "medium" }],
  ]);
  assert.equal(state.sources.get(JSON.stringify(["test", "planner"])), "fallback");
});

test("pairLabel drops the Claude prefix and sanitizes the name", () => {
  assert.equal(pairLabel("Claude Sonnet 5.5"), "Yes, implement with Sonnet 5.5");
  assert.equal(pairLabel("GPT-5.5 Sol\n", true), "Yes, compact and implement with GPT-5.5 Sol");
});

test("a named implementer is the first model and a selected pair's planner the second", () => {
  const worker: ModelSpec = { provider: "test", modelId: "worker", thinkingLevel: "high" };
  const pair: ApprovalInput = {
    planning: worker,
    implementerName: "Claude Sonnet 5.5",
    note: "Opus 5.5 answers its questions",
    alternate: { model: planner, name: "Claude Opus 5.5", kind: "planner" },
  };
  const first = fixture({ input: pair });
  assert.match(text(first.component), /Model: Sonnet 5\.5 \(Opus 5\.5 answers its questions\) · tab/u);
  assert.match(text(first.component), /Context: compact to plan \(other model\)/u);
  first.component.handleInput("\r");
  assert.deepEqual(first.done.mock.calls[0]?.[0]?.choice, { kind: "compact-here" });
  const second = fixture({ input: pair });
  second.component.handleInput("\t");
  assert.match(text(second.component), /Model: Opus 5\.5 · tab/u);
  assert.doesNotMatch(text(second.component), /answers its questions/u);
  assert.match(text(second.component), /Context: keep conversation/u);
  second.component.handleInput("\r");
  assert.deepEqual(second.done.mock.calls[0]?.[0]?.choice, { kind: "here", alternate: true });
  assert.equal(shortModelName("Claude Opus 5.5\n"), "Opus 5.5");
});

test("the optional note is on the Model line, sanitized, and absent without it", () => {
  const plain = fixture();
  assert.ok(!text(plain.component).includes("("));
  plain.component.dispose();
  const note = "Sonnet implements; Opus answers its questions.";
  const noted = fixture({ input: { ...input, note: `${note}\x1b[31m\n` } });
  for (const width of [46, 120]) {
    const rendered = noted.component
      .render(width)
      .map((line) => stripVTControlCharacters(line).trim())
      .join(" ");
    assert.ok(rendered.includes(`Model: planner (${note})`), rendered);
    assert.ok(!rendered.includes("\x1b"));
  }
  noted.component.dispose();
});

test("the Context line gives the size and why compacting is the default", () => {
  const cold = fixture({ input: { ...input, context: { tokens: 182_000, cold: true, big: true } } });
  assert.match(text(cold.component), /Context: compact to plan \(182k tokens, cache cold\) · c/u);
  const small = fixture({ input: { ...input, context: { tokens: 800, cold: false, big: false } } });
  assert.match(text(small.component), /Context: keep conversation \(800 tokens\) · c/u);
  const bare = fixture({ input: { ...input, context: { cold: false, big: true } } });
  assert.match(text(bare.component), /Context: compact to plan · c/u);
});

test("the context default: your setting, another model, a cold or big cache, else keep", () => {
  const quiet = { cold: false, big: false };
  assert.equal(defaultImplementationContext(undefined, false), "keep");
  assert.equal(defaultImplementationContext(quiet, false), "keep");
  assert.equal(defaultImplementationContext(quiet, true), "clear");
  assert.equal(defaultImplementationContext({ cold: true, big: false }, false), "clear");
  assert.equal(defaultImplementationContext({ cold: false, big: true }, false), "clear");
  assert.equal(defaultImplementationContext({ ...quiet, configured: "keep" }, true), "keep");
  assert.equal(defaultImplementationContext({ cold: true, big: true, configured: "keep" }, false), "keep");
  assert.equal(defaultImplementationContext({ ...quiet, configured: "clear" }, false), "clear");
});

test("c toggles the context and a chosen context ignores the model's automatic one", () => {
  const worker: ModelSpec = { provider: "test", modelId: "worker", thinkingLevel: "high" };
  const { component, state, done } = fixture({
    input: { planning: planner, alternate: { model: worker, name: "Worker", kind: "pair-worker" } },
  });
  component.handleInput("c");
  assert.equal(state.context, "clear");
  component.handleInput("\t");
  assert.match(text(component), /Context: compact to plan/u);
  component.handleInput("C");
  assert.equal(state.context, "keep");
  assert.match(text(component), /Context: keep conversation/u);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls[0]?.[0]?.choice, { kind: "here", alternate: true });
});

test("RPC follows the context default and says who answers the worker's questions", async () => {
  const cold = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(KEEP);
  await pickApproval(rpcContext(cold), { context: { cold: true, big: false } }, createApprovalState());
  assert.deepEqual(cold.mock.calls[0]?.[1], [COMPACT_HERE, HERE, EDIT, SAVE, KEEP]);
  const configured = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(KEEP);
  await pickApproval(
    rpcContext(configured),
    { context: { cold: true, big: true, configured: "keep" } },
    createApprovalState(),
  );
  assert.equal(configured.mock.calls[0]?.[1][0], HERE);
  const pair = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(KEEP);
  await pickApproval(
    rpcContext(pair),
    { implementerName: "Claude Sonnet 5.5", note: "Opus 5.5 answers its questions" },
    createApprovalState(),
  );
  assert.equal(pair.mock.calls[0]?.[0], `${APPROVAL_QUESTION} With Sonnet 5.5, Opus 5.5 answers its questions.`);
  assert.equal(pair.mock.calls[0]?.[1][0], pairLabel("Claude Sonnet 5.5", true));
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
  assert.equal(state.selectedId, "implement");
  terminal.handleInput("c");
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

  const worker: ModelSpec = { provider: "test", modelId: "worker", thinkingLevel: "high" };
  const pair: ApprovalInput = { planning: planner, alternate: { model: worker, name: "Worker", kind: "pair-worker" } };
  const picked = createApprovalState();
  const remoteWins = vi
    .fn<ExtensionContext["ui"]["select"]>()
    .mockResolvedValueOnce(pairLabel("Worker", true))
    .mockResolvedValueOnce("low");
  const won = await pickApproval(
    tuiContext(() => {}),
    pair,
    picked,
    undefined,
    { select: remoteWins } as never,
  );
  assert.equal(won?.remote, true);
  assert.deepEqual(won?.choice, { kind: "compact-here", alternate: true });
  assert.equal(picked.modelIndex, 1);
  assert.equal(picked.context, "clear");
});

test("implement is first/default and selection uses the Pi bindings", () => {
  const first = fixture();
  first.component.handleInput("\r");
  assert.deepEqual(first.done.mock.calls, [
    [{ effortSource: "fallback", choice: { kind: "here" }, thinkingLevel: "high" }],
  ]);
  first.component.handleInput(down);
  first.component.handleInput("\r");
  assert.equal(first.done.mock.calls.length, 1);

  const compact = fixture();
  compact.component.handleInput("c");
  compact.component.handleInput("\r");
  assert.deepEqual(compact.done.mock.calls, [
    [{ effortSource: "fallback", choice: { kind: "compact-here" }, thinkingLevel: "high" }],
  ]);
  assert.equal(compact.requestRender.mock.calls.length, 1);

  const edit = fixture();
  edit.component.handleInput(down);
  edit.component.handleInput("\r");
  assert.deepEqual(edit.done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "edit" } }]]);

  const keep = fixture();
  keep.component.handleInput(up);
  keep.component.handleInput("\r");
  assert.deepEqual(keep.done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "keep" } }]]);

  const single = fixture();
  single.component.handleInput("\t");
  assert.equal(single.requestRender.mock.calls.length, 0);
});

test("Save for later is between Edit and Keep; effort keys adjust the settings, not the action", () => {
  const { component, state, done } = fixture();
  component.handleInput(up); // Keep
  component.handleInput(up); // Save
  assert.equal(state.selectedId, "save");
  assert.ok(text(component).includes(`→ ${SAVE}`));
  component.handleInput(right);
  assert.match(text(component), /Effort: low/u);
  assert.ok(text(component).includes(`→ ${SAVE}`));
  component.handleInput(up);
  assert.equal(state.selectedId, "edit");
  component.handleInput(down);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "save" } }]]);
});

test("left/right cycle only supported efforts, on every row", () => {
  const { component, state, requestRender, done } = fixture();
  component.handleInput(right); // high -> low, no registry-default pseudo-level
  assert.match(text(component), /Effort: low · ←\/→/u);
  component.handleInput(down);
  assert.match(text(component), /Effort: low · ←\/→/u);
  component.handleInput(left);
  assert.match(text(component), /Effort: high · ←\/→/u);
  component.handleInput(left);
  component.handleInput(left);
  assert.match(text(component), /Effort: low · ←\/→/u);
  component.handleInput(right);
  component.handleInput(up);
  assert.match(text(component), /Effort: medium · ←\/→/u);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [[{ effortSource: "manual", choice: { kind: "here" }, thinkingLevel: "medium" }]]);
  assert.equal(state.efforts.get(JSON.stringify(["test", "planner"])), "medium");
  assert.equal(requestRender.mock.calls.length, 7);
});

test("selection, effort, model and context survive Edit", () => {
  const state = createApprovalState();
  const first = fixture({ state });
  first.component.handleInput(left); // high -> medium
  first.component.handleInput("c");
  first.component.handleInput(down);
  first.component.handleInput("\r");
  assert.deepEqual(first.done.mock.calls, [[{ effortSource: "fallback", choice: { kind: "edit" } }]]);

  const second = fixture({ state });
  assert.equal(state.selectedId, "edit");
  assert.match(text(second.component), /Effort: medium/u);
  assert.match(text(second.component), /Context: compact to plan/u);
  second.component.handleInput(up);
  assert.equal(state.selectedId, "implement");
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
          .includes(`Effort: ${expected ?? "default"}`),
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
  assert.match(text(component), /Effort: default/u);
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
      assert.equal(lines[2], ` ${APPROVAL_QUESTION}`);
      assert.equal(lines[3], " Model: planner");
      assert.equal(lines[4], ` Effort: ${changed ? "medium" : "high"} · ←/→`);
      assert.equal(lines[5], " Context: keep conversation · c");
      assert.equal(lines[6], "");
      assert.equal(lines[7], ` → ${IMPLEMENT}`);
      assert.equal(lines[8], `   ${EDIT}`);
      assert.equal(lines[9], `   ${SAVE}`);
      assert.equal(lines[10], `   ${KEEP}`);
      assert.equal(lines[11], "");
      assert.equal(
        lines
          .slice(12, -2)
          .map((line) => line.trim())
          .join(" "),
        APPROVAL_HINT,
      );
      assert.equal(lines.at(-2), "");
      assert.equal(lines.length, width === 46 ? 16 : 15);
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
  assert.equal(state.selectedId, "implement");
  assert.deepEqual(component.render(46), before);
  assert.equal(requestRender.mock.calls.length, 0);
  component.dispose();
});

test("pickApproval uses one TUI component, current session effort, and cleans up on failure", async () => {
  const state = createApprovalState();
  const ctx = tuiContext((component) => {
    component.handleInput(left);
    component.handleInput("c");
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
  assert.equal(state.selectedId, "implement");
  assert.equal(state.context, "clear");
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
    assert.match(text(component), /Effort: high/u);
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
  assert.match(text(next.component), /Effort: medium/u);
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
