import { type ExtensionContext, initTheme } from "@earendil-works/pi-coding-agent";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, expect, test } from "vitest";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { choosePlanApproval, EDIT_CHOICE, PlanReader } from "../src/plan-approval.js";

const OPTIONS = ["Implement in auto mode", "Implement in yolo mode", "Implement in a fresh session", "Keep planning"];
const PLAN = `# Beginning of plan\n\n${Array.from({ length: 80 }, (_, i) => `Step ${i + 1}: do part ${i + 1}.`).join("\n\n")}`;
const ESC = String.fromCharCode(27);
const strip = (line: string) => line.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "").trimEnd();

beforeAll(() => {
  initTheme("dark", false);
  // Pi's app bindings, as the interactive mode installs them (Ctrl+G edits the plan).
  setKeybindings(new KeybindingsManager());
});

function reader(rows = 30) {
  const results: Array<string | undefined> = [];
  const view = new PlanReader(
    PLAN,
    OPTIONS,
    "Keep planning",
    theme,
    () => rows,
    (choice) => results.push(choice),
    () => {},
  );
  return { view, results };
}

test.each([46, 120])("at %i columns the plan is the whole screen, with no chrome", (columns) => {
  const { view } = reader();
  const lines = view.render(columns).map(strip);
  expect(lines).toHaveLength(30);
  expect(lines[0]).toContain("Beginning of plan");
  expect(lines.join("\n")).not.toMatch(/─|navigate|ctrl\+g|Implement this plan/u);
});

test("the plan is centred in a readable column on wide screens", () => {
  const { view } = reader();
  const first = strip(view.render(200)[0] as string);
  expect(first.indexOf("Beginning")).toBeGreaterThanOrEqual(50);
});

test("keys and the wheel scroll, clamped to the plan", () => {
  const { view } = reader(20);
  const top = () => strip(view.render(80)[0] as string);
  const start = top();
  view.handleInput("j");
  expect(top()).not.toBe(start);
  view.handleInput("g");
  expect(top()).toBe(start);
  view.handleInput("\x04"); // ctrl+d
  const half = top();
  expect(half).not.toBe(start);
  view.handleInput("\x15"); // ctrl+u
  expect(top()).toBe(start);
  view.handleMouse({ type: "wheel", wheelDelta: 1, x: 0, y: 0 } as never);
  expect(top()).not.toBe(start);
  view.handleInput("G");
  expect(view.render(80).map(strip).join("\n")).toContain("Step 80");
  view.handleInput("k");
  view.handleInput("G");
  view.handleInput("G");
  expect(view.render(80).map(strip).at(-1)).toContain("Step 80");
});

test("Enter shows only the choices over the plan's end; Esc goes back to reading", () => {
  const { view, results } = reader(20);
  view.handleInput("\r");
  const lines = view.render(60).map(strip);
  expect(lines).toHaveLength(20);
  expect(lines.slice(-4)).toEqual([
    " → Implement in auto mode",
    "   Implement in yolo mode",
    "   Implement in a fresh session",
    "   Keep planning",
  ]);
  expect(lines[0]).toContain("Beginning of plan");
  expect(lines.join("\n")).not.toMatch(/─|navigate|Implement this plan/u);
  view.handleInput(ESC);
  expect(view.isChoosing).toBe(false);
  expect(results).toEqual([]);
  view.handleInput("\r");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  expect(results).toEqual(["Implement in yolo mode"]);
});

test("Ctrl+G edits from either stage; Esc while reading keeps planning", () => {
  const a = reader();
  a.view.handleInput("\x07");
  expect(a.results).toEqual([EDIT_CHOICE]);
  const b = reader();
  b.view.handleInput("\r");
  b.view.handleInput("\x07");
  expect(b.results).toEqual([EDIT_CHOICE]);
  const c = reader();
  c.view.handleInput(ESC);
  expect(c.results).toEqual(["Keep planning"]);
});

function tuiContext(custom: (factory: unknown, options: unknown) => Promise<unknown>) {
  return {
    mode: "tui",
    ui: { custom, select: async () => "select" },
  } as unknown as ExtensionContext;
}

test("the TUI opens the reader full screen; abort closes it", async () => {
  let opened: { options: unknown; component: PlanReader } | undefined;
  const controller = new AbortController();
  const ctx = tuiContext(
    (factory, options) =>
      new Promise((resolve) => {
        const component = (factory as (...args: unknown[]) => PlanReader)(
          { terminal: { rows: 24 }, requestRender() {} },
          theme,
          undefined,
          resolve,
        );
        opened = { options, component };
      }),
  );
  const result = choosePlanApproval(ctx, PLAN, "Implement?", OPTIONS, "Keep planning", controller.signal);
  await Promise.resolve();
  expect(opened?.component).toBeInstanceOf(PlanReader);
  expect(opened?.options).toMatchObject({ overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
  controller.abort();
  expect(await result).toBeUndefined();
});

test("RPC asks with Pi's select, with Edit as a row", async () => {
  let asked: string[] = [];
  const ctx = {
    mode: "rpc",
    ui: {
      select: async (_title: string, options: string[]) => {
        asked = options;
        return options[0];
      },
    },
  } as unknown as ExtensionContext;
  expect(await choosePlanApproval(ctx, PLAN, "Implement?", OPTIONS, "Keep planning")).toBe(OPTIONS[0]);
  expect(asked).toEqual([...OPTIONS.slice(0, -1), EDIT_CHOICE, "Keep planning"]);
});
