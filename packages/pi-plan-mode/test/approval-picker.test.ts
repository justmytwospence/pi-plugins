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
  handoffLabel,
  KEEP,
  OPTION_MAX,
  pickApproval,
} from "../src/approval-picker.js";
import type { ModelSpec, ModelSpecThinkingLevel } from "../src/implementation-models.js";

const planner: ModelSpec = { provider: "test", modelId: "planner", thinkingLevel: "high" };
const target: ModelSpec = { provider: "test", modelId: "worker" };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = getKeybindings();
const supported: Array<ModelSpecThinkingLevel | undefined> = [undefined, "low", "medium", "high"];
const input: ApprovalInput = { planning: planner, targets: [{ target, targetName: "Worker" }] };
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
      getAvailable: () => [
        { provider: "test", id: "planner", reasoning: true },
        { provider: "test", id: "worker", reasoning: true },
      ],
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

test("direct implementation is first/default and selection uses the Pi bindings", () => {
  const first = fixture();
  first.component.handleInput("\r");
  assert.deepEqual(first.done.mock.calls, [[{ choice: { kind: "here" }, thinkingLevel: "high" }]]);
  first.component.handleInput(down);
  first.component.handleInput("\r");
  assert.equal(first.done.mock.calls.length, 1);

  const compact = fixture();
  compact.component.handleInput(down);
  compact.component.handleInput("\r");
  assert.deepEqual(compact.done.mock.calls, [[{ choice: { kind: "compact-here" }, thinkingLevel: "high" }]]);
  assert.equal(compact.requestRender.mock.calls.length, 1);

  const handoff = fixture();
  handoff.component.handleInput(down);
  handoff.component.handleInput(down);
  handoff.component.handleInput("\r");
  assert.deepEqual(handoff.done.mock.calls, [
    [{ choice: { kind: "handoff", target, targetName: "Worker" }, thinkingLevel: "medium" }],
  ]);
  assert.deepEqual(target, { provider: "test", modelId: "worker" });

  const keep = fixture();
  keep.component.handleInput(up);
  keep.component.handleInput("\r");
  assert.deepEqual(keep.done.mock.calls, [[{ choice: { kind: "keep" } }]]);
});

test("left/right cycle only supported efforts; both direct rows share effort", () => {
  const { component, state, requestRender, done } = fixture();
  component.handleInput(right); // high -> low, no registry-default pseudo-level
  assert.match(component.render(120).join("\n"), /←\/→ effort: low/u);
  component.handleInput(down);
  assert.match(component.render(120).join("\n"), /←\/→ effort: low/u);
  component.handleInput(left);
  assert.match(component.render(120).join("\n"), /←\/→ effort: high/u);
  component.handleInput(down);
  assert.match(component.render(120).join("\n"), /←\/→ effort: medium/u);
  component.handleInput(left);
  component.handleInput(up);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [[{ choice: { kind: "compact-here" }, thinkingLevel: "high" }]]);
  assert.equal(state.efforts.get(JSON.stringify(["test", "worker"])), "low");
  assert.equal(requestRender.mock.calls.length, 6);
});

test("selection and per-model effort survive Edit and target reordering", () => {
  const state = createApprovalState();
  const first = fixture({ state });
  first.component.handleInput(left); // planner high -> medium
  first.component.handleInput(down);
  first.component.handleInput(down);
  first.component.handleInput(right); // worker medium -> high
  first.component.handleInput(down);
  first.component.handleInput("\r");
  assert.deepEqual(first.done.mock.calls, [[{ choice: { kind: "edit" } }]]);

  const second = fixture({ state });
  assert.equal(state.selectedId, "edit");
  assert.match(second.component.render(120).join("\n"), /Select an implementation choice to adjust effort/u);
  second.component.handleInput(up);
  assert.match(second.component.render(120).join("\n"), /effort: high/u);
  second.component.dispose();

  const other = { target: { provider: "test", modelId: "other" }, targetName: "Other" };
  const reordered = fixture({ state, input: { ...input, targets: [other, ...input.targets] } });
  assert.match(reordered.component.render(120).join("\n"), /→ Yes, hand off to Worker/u);
  reordered.component.handleInput(up);
  reordered.component.handleInput(up);
  assert.match(reordered.component.render(120).join("\n"), /effort: medium/u);
  reordered.component.dispose();
});

test("effort defaults prefer configured suffix, then setting, then medium; normalize down", () => {
  const cases: [ModelSpecThinkingLevel | undefined, ModelSpecThinkingLevel | undefined, ModelSpecThinkingLevel][] = [
    ["max", "low", "high"],
    ["low", "high", "low"],
    [undefined, "xhigh", "high"],
    [undefined, undefined, "medium"],
    ["off", undefined, "low"],
  ];
  for (const [suffix, fallback, expected] of cases) {
    const { component, done } = fixture({
      input: {
        ...input,
        defaultThinkingLevel: fallback,
        targets: [{ target: { ...target, thinkingLevel: suffix }, targetName: "Worker" }],
      },
    });
    component.handleInput(down);
    component.handleInput(down);
    for (const width of [46, 120]) {
      const rendered = component.render(width).join("\n");
      assert.ok(rendered.includes(`←/→ effort: ${expected}`));
      assert.ok(rendered.includes(`→ ${handoffLabel("Worker", expected)}`));
    }
    component.handleInput("\r");
    assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, expected);
  }
  const current = fixture({
    input: { ...input, planning: { ...planner, thinkingLevel: "max" }, defaultThinkingLevel: "low" },
  });
  current.component.handleInput("\r");
  assert.equal(current.done.mock.calls[0]?.[0]?.thinkingLevel, "high");
});

test("handoff labels follow arrow changes and retained effort on every render", () => {
  const state = createApprovalState();
  const configured = {
    ...input,
    targets: [{ target: { ...target, thinkingLevel: "max" as const }, targetName: "Worker" }],
  };
  const { component, done } = fixture({ input: configured, state });
  component.handleInput(down);
  component.handleInput(down);
  for (const [key, expected] of [
    [right, "low"],
    [left, "high"],
    [left, "medium"],
  ] as const) {
    component.handleInput(key);
    for (const width of [46, 120]) {
      const rendered = component.render(width).join("\n");
      assert.ok(rendered.includes(`←/→ effort: ${expected}`));
      assert.ok(rendered.includes(`→ ${handoffLabel("Worker", expected)}`));
      assert.ok(!rendered.includes("(max)"));
    }
  }
  component.handleInput("\r");
  assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, "medium");
  const reopened = fixture({ input: configured, state });
  assert.ok(
    reopened.component
      .render(120)
      .join("\n")
      .includes(`→ ${handoffLabel("Worker", "medium")}`),
  );
  reopened.component.dispose();
});

test("nonreasoning handoffs omit a configured effort suffix", () => {
  const { component, done } = fixture({
    input: { ...input, targets: [{ target: { ...target, thinkingLevel: "high" }, targetName: "Worker" }] },
    efforts: () => [undefined],
  });
  component.handleInput(down);
  component.handleInput(down);
  const rendered = component.render(120).join("\n");
  assert.ok(rendered.includes("Effort: not supported"));
  assert.ok(rendered.includes(`→ ${handoffLabel("Worker")}`));
  assert.ok(!rendered.includes("(high)"));
  component.handleInput("\r");
  assert.equal(done.mock.calls[0]?.[0]?.thinkingLevel, undefined);
});

test("nonreasoning models have no effort control or returned level", () => {
  const { component, done, requestRender } = fixture({ efforts: () => [undefined] });
  assert.match(component.render(46).join("\n"), /Effort: not supported/u);
  component.handleInput(right);
  component.handleInput(left);
  assert.equal(requestRender.mock.calls.length, 0);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [[{ choice: { kind: "here" } }]]);
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

test("clipped labels retain distinct model identity and visible-column bounds", () => {
  const name = "漢字".repeat(40);
  const a = { target: { ...target, modelId: "a" }, targetName: name };
  const b = { target: { ...target, modelId: "b" }, targetName: `${name} extra` };
  assert.equal(handoffLabel(a.targetName), handoffLabel(b.targetName));
  assert.ok(visibleWidth(handoffLabel(a.targetName)) <= OPTION_MAX);
  const { component, done } = fixture({ input: { ...input, targets: [a, b] } });
  for (const _ of [1, 2, 3]) component.handleInput(down);
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls[0]?.[0]?.choice, { kind: "handoff", ...b });
  assert.equal(handoffLabel("Worker", "high"), "Yes, hand off to Worker (high)");
  assert.equal(handoffLabel("\x1b[31mWorker\n"), "Yes, hand off to Worker ");
});

test("standard Pi layout at 46 and 120 columns, zero/one/two targets and effort changes", () => {
  for (const width of [46, 120]) {
    for (const targets of [
      [],
      input.targets,
      [...input.targets, { target: { ...target, modelId: "second" }, targetName: "Second" }],
    ]) {
      const { component } = fixture({ input: { ...input, targets } });
      for (const changed of [false, true]) {
        if (changed) component.handleInput(left);
        const rendered = component.render(width).map(stripVTControlCharacters);
        assert.ok(rendered.every((line) => visibleWidth(line) === width));
        const lines = rendered.map((line) => line.trimEnd());
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.equal(lines[0], "─".repeat(width));
        assert.equal(lines.at(-1), "─".repeat(width));
        assert.equal(lines[1], "");
        assert.equal(lines[2], ` ${APPROVAL_QUESTION} ←/→ effort: ${changed ? "medium" : "high"}`);
        assert.equal(lines[3], "");
        assert.equal(lines[4], ` → ${HERE}`);
        assert.equal(lines[5], `   ${COMPACT_HERE}`);
        assert.equal(lines[6 + targets.length], `   ${EDIT}`);
        assert.equal(lines[7 + targets.length], `   ${KEEP}`);
        assert.equal(lines[8 + targets.length], "");
        assert.equal(
          lines
            .slice(9 + targets.length, -2)
            .map((line) => line.trim())
            .join(" "),
          APPROVAL_HINT,
        );
        assert.equal(lines.at(-2), "");
        assert.equal(lines.length, (width === 46 ? 13 : 12) + targets.length);
      }
      component.dispose();
    }
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
  const result = await pickApproval(ctx, { targets: [] }, state);
  assert.deepEqual(result, { choice: { kind: "compact-here" }, thinkingLevel: "medium" });
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
  assert.deepEqual(result, { choice: { kind: "here" }, thinkingLevel: "low" });
  assert.deepEqual(select.mock.calls[0]?.slice(0, 2), [
    APPROVAL_QUESTION,
    [HERE, COMPACT_HERE, handoffLabel("Worker", "medium"), EDIT, KEEP],
  ]);
  assert.deepEqual(select.mock.calls[1]?.[1], ["high", "off", "minimal", "low", "medium"]);
  for (const answers of [[undefined], [COMPACT_HERE, undefined, undefined]]) {
    const cancel = vi.fn<ExtensionContext["ui"]["select"]>();
    for (const answer of answers) cancel.mockResolvedValueOnce(answer);
    assert.equal(await pickApproval(rpcContext(cancel), input, createApprovalState()), undefined);
    assert.equal(cancel.mock.calls.length, answers.length);
  }
});

test("RPC effort cancellation returns to the retained action and preserves per-model efforts", async () => {
  const state = createApprovalState();
  state.efforts.set(JSON.stringify(["test", "planner"]), "low");
  state.efforts.set(JSON.stringify(["test", "worker"]), "high");
  const worker = handoffLabel("Worker", "high");
  const answers = [COMPACT_HERE, undefined, worker, undefined, COMPACT_HERE, "low"];
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockImplementation(async () => answers.shift());
  assert.deepEqual(await pickApproval(rpcContext(select), input, state), {
    choice: { kind: "compact-here" },
    thinkingLevel: "low",
  });
  assert.deepEqual(
    select.mock.calls.map(([title]) => title),
    [
      APPROVAL_QUESTION,
      "Implementation effort",
      APPROVAL_QUESTION,
      "Implementation effort",
      APPROVAL_QUESTION,
      "Implementation effort",
    ],
  );
  assert.equal(select.mock.calls[2]?.[1][0], COMPACT_HERE);
  assert.equal(select.mock.calls[4]?.[1][0], worker);
  assert.deepEqual(
    [1, 3, 5].map((index) => select.mock.calls[index]?.[1][0]),
    ["low", "high", "low"],
  );
  assert.equal(state.selectedId, "compact-here");
  assert.equal(state.efforts.get(JSON.stringify(["test", "worker"])), "high");
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

test("RPC handles nonexecution and nonreasoning choices without another selector", async () => {
  for (const label of [EDIT, KEEP, HERE]) {
    const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValueOnce(label);
    const ctx = rpcContext(select, { modelRegistry: { getAvailable: () => [], find: () => undefined } as never });
    const result = await pickApproval(ctx, input, createApprovalState());
    assert.deepEqual(result, { choice: { kind: label === EDIT ? "edit" : label === KEEP ? "keep" : "here" } });
    assert.equal(select.mock.calls.length, 1);
  }
});

test("RPC disambiguates clipped-label collisions and returns the chosen target", async () => {
  const name = "a".repeat(80);
  const targets = [
    { target: { ...target, modelId: "a" }, targetName: name },
    { target: { ...target, modelId: "b" }, targetName: `${name}b` },
  ];
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockImplementationOnce(async (_question, options) => {
    assert.equal(new Set(options).size, options.length);
    assert.ok(options.every((option) => visibleWidth(option) <= OPTION_MAX));
    return options[3];
  });
  const ctx = rpcContext(select, { modelRegistry: { getAvailable: () => [], find: () => undefined } as never });
  assert.deepEqual(await pickApproval(ctx, { ...input, targets }, createApprovalState()), {
    choice: { kind: "handoff", ...targets[1] },
  });
});

test("catalog registry fallback supplies the current model's supported effort outside the available list", async () => {
  const find = vi.fn(() => ({ provider: "test", id: "planner", reasoning: true, thinkingLevelMap: { high: null } }));
  const ctx = tuiContext((component) => component.handleInput("\r"), {
    modelRegistry: { getAvailable: () => [], find } as never,
  });
  assert.deepEqual(await pickApproval(ctx, { targets: [] }, createApprovalState()), {
    choice: { kind: "here" },
    thinkingLevel: "medium",
  });
  assert.ok(find.mock.calls.length > 0);
});

test("RPC regenerates normalized handoff labels when returning from effort cancellation", async () => {
  const state = createApprovalState();
  const configured = { ...target, thinkingLevel: "max" as const };
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockImplementation(async (_question, options) => {
    switch (select.mock.calls.length) {
      case 1:
        assert.ok(options.includes(handoffLabel("Worker", "medium")));
        assert.ok(!options.some((label) => label.includes("(max)")));
        return handoffLabel("Worker", "medium");
      case 2:
        assert.equal(options[0], "medium");
        // Simulate current per-model state changing before the action list is rendered again.
        state.efforts.set(JSON.stringify(["test", "worker"]), "low");
        return undefined;
      case 3:
        assert.equal(options[0], handoffLabel("Worker", "low"));
        assert.ok(!options.includes(handoffLabel("Worker", "medium")));
        return options[0];
      default:
        assert.equal(options[0], "low");
        return options[0];
    }
  });
  const ctx = rpcContext(select);
  ctx.modelRegistry.getAvailable = () =>
    [{ provider: "test", id: "worker", reasoning: true, thinkingLevelMap: { high: null } }] as never;
  assert.deepEqual(
    await pickApproval(ctx, { ...input, targets: [{ target: configured, targetName: "Worker" }] }, state),
    { choice: { kind: "handoff", target: configured, targetName: "Worker" }, thinkingLevel: "low" },
  );
  assert.equal(select.mock.calls.length, 4);
});

test("RPC puts the normalized per-model effort first so Enter retains the default", async () => {
  const select = vi
    .fn<ExtensionContext["ui"]["select"]>()
    .mockImplementationOnce(async (_question, options) => options[2])
    .mockImplementationOnce(async (_question, options) => {
      assert.equal(options[0], "medium");
      return options[0];
    });
  assert.deepEqual(await pickApproval(rpcContext(select), input, createApprovalState()), {
    choice: { kind: "handoff", target, targetName: "Worker" },
    thinkingLevel: "medium",
  });
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
