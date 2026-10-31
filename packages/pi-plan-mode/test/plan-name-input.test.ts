import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { PlanNameInput, promptPlanName } from "../src/plan-name-input.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = getKeybindings();
const options = { suggestion: "my-plan", directory: "/project/plans" };

function fixture(signal?: AbortSignal, suggestion: string | undefined = options.suggestion) {
  const done = vi.fn<(value: string | undefined) => void>();
  const requestRender = vi.fn();
  const component = new PlanNameInput({ ...options, suggestion }, theme, keys, requestRender, done, signal);
  return { component, done, requestRender };
}

function context(mode: "tui" | "rpc" = "rpc") {
  return {
    hasUI: true,
    mode,
    ui: { select: vi.fn(), input: vi.fn(), custom: vi.fn() },
  } as unknown as ExtensionContext;
}

function plain(component: PlanNameInput, width = 120) {
  return component
    .render(width)
    .map((line) =>
      stripVTControlCharacters(line.replaceAll("\x1b_pi:fc\x07", "").replaceAll("\x1b_pi:/fc\x07", "")).replaceAll(
        CURSOR_MARKER,
        "",
      ),
    );
}

test("real input renders one prefilled › field in the Pi layout, with focus and bounded widths", () => {
  const { component, done } = fixture();
  assert.equal(component.focused, false);
  component.focused = true;
  assert.equal(component.focused, true);
  assert.ok(component.render(120).join("\n").includes(CURSOR_MARKER));
  for (const width of [1, 12, 46, 120]) {
    assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
  }
  for (const width of [46, 120]) {
    const lines = plain(component, width);
    assert.equal(lines.filter((line) => line.trimStart().startsWith("› ")).length, 1);
    assert.ok(lines.some((line) => line.includes("› my-plan")));
    assert.ok(lines.includes(" Save plan as"));
    assert.ok(lines.includes(" Destination: /project/plans"));
    assert.ok(lines.some((line) => line.includes(".md")));
    assert.equal(lines.at(-2), " enter submit  escape/ctrl+c cancel");
    assert.equal(lines.at(-1), "─".repeat(width));
  }
  component.focused = false;
  assert.ok(!component.render(120).join("\n").includes(CURSOR_MARKER));
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [["my-plan"]]);
});

test("editing uses public Input navigation, deletion, replacement and paste", () => {
  const { component, done, requestRender } = fixture();
  component.handleInput("!"); // starts at the end of the prefill
  component.handleInput("\x1b[D");
  component.handleInput("\x7f");
  component.handleInput("N");
  assert.ok(plain(component).join("\n").includes("my-plaN!"));
  component.handleInput("\x05"); // Ctrl+E
  component.handleInput("\x15"); // Ctrl+U replaces the prefilled value
  component.handleInput("\x1b[200~replacement\x1b[201~");
  component.handleInput("\r");
  assert.deepEqual(done.mock.calls, [["replacement"]]);
  assert.ok(requestRender.mock.calls.length > 0);
  component.handleInput("ignored");
  component.handleInput("\r");
  assert.equal(done.mock.calls.length, 1);
});

for (const cancel of ["\x1b", "\x03"]) {
  test(`cancel ${JSON.stringify(cancel)} finishes once and removes abort listener`, () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { component, done } = fixture(controller.signal);
    component.handleInput(cancel);
    controller.abort();
    component.handleInput("\r");
    assert.deepEqual(done.mock.calls, [[undefined]]);
    assert.ok(remove.mock.calls.some(([event]) => event === "abort"));
  });
}

test("abort, pre-abort and disposal release listeners and never finish twice", () => {
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const { component, done } = fixture(controller.signal);
  controller.abort();
  component.handleInput("\r");
  component.dispose();
  assert.deepEqual(done.mock.calls, [[undefined]]);
  assert.ok(remove.mock.calls.some(([event]) => event === "abort"));
  assert.deepEqual(fixture(controller.signal).done.mock.calls, [[undefined]]);
  const active = new AbortController();
  const disposed = fixture(active.signal);
  disposed.component.dispose();
  active.abort();
  disposed.component.handleInput("\r");
  assert.equal(disposed.done.mock.calls.length, 0);
});

test("TUI prompt mounts the actual component, returns edits, and cleans up on failure", async () => {
  const ctx = context("tui");
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  ctx.ui.custom = (async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
    return new Promise((resolve) => {
      const component = factory({ requestRender() {} } as never, theme, keys as never, (result) =>
        resolve(result as never),
      ) as PlanNameInput;
      assert.ok(component instanceof PlanNameInput);
      component.handleInput("-edited");
      component.handleInput("\r");
    });
  }) as ExtensionContext["ui"]["custom"];
  assert.equal(await promptPlanName(ctx, options, controller.signal), "my-plan-edited");
  assert.ok(remove.mock.calls.some(([event]) => event === "abort"));
  ctx.ui.custom = (async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
    factory({ requestRender() {} } as never, theme, keys as never, () => {});
    throw new Error("mount failed");
  }) as ExtensionContext["ui"]["custom"];
  await assert.rejects(promptPlanName(ctx, options, controller.signal), /mount failed/);
  assert.equal(remove.mock.calls.length, 3); // finish, finally, then failed-mount finally
});

test("TUI abort completes the actual mounted dialog", async () => {
  const ctx = context("tui");
  const controller = new AbortController();
  ctx.ui.custom = (async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
    return new Promise((resolve) => {
      factory({ requestRender() {} } as never, theme, keys as never, (result) => resolve(result as never));
      controller.abort();
    });
  }) as ExtensionContext["ui"]["custom"];
  assert.equal(await promptPlanName(ctx, options, controller.signal), undefined);
});

test("RPC offers suggestion explicitly, or opens a separate input with the same signal", async () => {
  const ctx = context();
  const signal = new AbortController().signal;
  const select = vi.fn<ExtensionContext["ui"]["select"]>().mockResolvedValue("Use suggested name");
  const input = vi.fn<ExtensionContext["ui"]["input"]>().mockResolvedValue("different");
  ctx.ui.select = select;
  ctx.ui.input = input;
  assert.equal(await promptPlanName(ctx, options, signal), "my-plan");
  assert.deepEqual(select.mock.calls[0]?.[1], ["Use suggested name", "Enter different name", "Cancel"]);
  assert.equal(select.mock.calls[0]?.[2]?.signal, signal);
  assert.match(select.mock.calls[0]?.[0] ?? "", /my-plan/);
  assert.equal(input.mock.calls.length, 0);
  select.mockResolvedValue("Enter different name");
  assert.equal(await promptPlanName(ctx, options, signal), "different");
  assert.equal(input.mock.calls[0]?.[1], undefined); // never use suggestion as placeholder
  assert.equal(input.mock.calls[0]?.[2]?.signal, signal);
  assert.equal(input.mock.calls[0]?.[0], "Save plan as");
  for (const answer of ["Cancel", undefined, "unexpected"]) {
    select.mockResolvedValue(answer);
    assert.equal(await promptPlanName(ctx, options, signal), undefined);
  }
  assert.equal(input.mock.calls.length, 1);
});

test("RPC without suggestion goes straight to input and preserves empty/cancelled results", async () => {
  const ctx = context();
  const input = vi.fn<ExtensionContext["ui"]["input"]>();
  ctx.ui.input = input;
  for (const answer of ["custom", "", undefined]) {
    input.mockResolvedValue(answer);
    assert.equal(await promptPlanName(ctx, { directory: options.directory }), answer);
  }
  assert.equal(vi.mocked(ctx.ui.select).mock.calls.length, 0);
});

test("UI guards and RPC abort never accept stale answers or open another dialog", async () => {
  const ctx = context();
  const controller = new AbortController();
  controller.abort();
  assert.equal(await promptPlanName(ctx, options, controller.signal), undefined);
  ctx.hasUI = false;
  assert.equal(await promptPlanName(ctx, options), undefined);
  assert.equal(vi.mocked(ctx.ui.select).mock.calls.length, 0);
  ctx.hasUI = true;
  for (const stage of ["select", "input"] as const) {
    const active = new AbortController();
    const input = vi.fn<ExtensionContext["ui"]["input"]>().mockImplementation(async (_title, _placeholder, opts) => {
      assert.equal(opts?.signal, active.signal);
      active.abort();
      return "stale";
    });
    ctx.ui.input = input;
    ctx.ui.select = async (_title, _choices, opts) => {
      assert.equal(opts?.signal, active.signal);
      if (stage === "select") active.abort();
      return "Enter different name";
    };
    assert.equal(await promptPlanName(ctx, options, active.signal), undefined);
    assert.equal(input.mock.calls.length, stage === "select" ? 0 : 1);
  }
});
