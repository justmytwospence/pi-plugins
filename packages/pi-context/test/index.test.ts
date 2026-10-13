import { type ExtensionAPI, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import extension from "../src/index.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const tui = { terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() };

type Comp = {
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse(event: Record<string, unknown>): { handled?: boolean; render?: boolean } | undefined;
};

/** Runs each overlay factory, hands the component to `drive`, which must end it by calling done. */
function customStub(drive: (component: Comp, done: (value: unknown) => void, call: number) => void) {
  let call = 0;
  return async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => Comp) =>
    new Promise((resolve) => {
      const component = factory(tui, theme, {}, resolve);
      drive(component, resolve, call++);
    });
}

const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  type,
  button: "left",
  x,
  y,
  screenX: x,
  screenY: y,
  width: 64,
  height: 20,
  shift: false,
  alt: false,
  ctrl: false,
  ...extra,
});

describe("extension", () => {
  test("registers /context and reports in plain text outside the TUI", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
      getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object" } }],
    } as unknown as ExtensionAPI;
    extension(pi);
    expect([...commands.keys()]).toEqual(["context"]);

    const notify = vi.fn();
    await commands.get("context")!.handler("", {
      hasUI: true,
      mode: "rpc",
      model: { contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 10_000, percent: 5, contextWindow: 200_000 }),
      getSystemPrompt: () => "x".repeat(4_000),
      getSystemPromptOptions: () => ({ cwd: "/", selectedTools: ["read"] }),
      sessionManager: { buildContextEntries: () => [] },
      ui: { notify },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const [text, level] = notify.mock.calls[0];
    expect(level).toBe("info");
    expect(text).toContain("Context: 10.0k / 200k tokens (5.0%)");
    expect(text).toContain("System prompt: 1.0k tokens");
    expect(text).toContain("Free space: 190k tokens");
  });

  test("draws the dialog, opens a preview on Enter and on click, and closes on escape", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
      getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object" } }],
    } as unknown as ExtensionAPI;
    extension(pi);

    const frames: string[][] = [];
    const custom = customStub((component, done, call) => {
      const lines = component.render(64).map((line) => stripTerminalSequences(line));
      frames.push(lines);
      switch (call) {
        case 0: // dialog: move down once, Enter opens Memory
          component.handleInput("\x1b[B");
          component.handleInput("\r");
          break;
        case 1: // preview: scroll and close
          expect(component.handleMouse(mouse("wheel", 5, 5, { wheelDelta: 3 }))).toEqual({ handled: true, render: false });
          component.handleInput("\x1b");
          break;
        case 2: // dialog again: click the Skills row (local row 5 + 2)
          expect(component.handleMouse(mouse("click", 10, 7))).toEqual({ handled: true });
          break;
        case 3: // preview: click [esc] on the title row
          expect(component.handleMouse(mouse("click", 60, 1))).toEqual({ handled: true });
          break;
        default: // dialog: ctrl+c
          component.handleInput("\x03");
      }
      void done;
    });

    await commands.get("context")!.handler("", {
      hasUI: true,
      mode: "tui",
      model: { contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 10_000, percent: 5, contextWindow: 200_000 }),
      getSystemPrompt: () => "You are helpful.\n\nMEMORY BODY",
      getSystemPromptOptions: () => ({ cwd: "/", selectedTools: ["read"], contextFiles: [{ path: "/p/AGENTS.md", content: "MEMORY BODY" }] }),
      sessionManager: { buildContextEntries: () => [] },
      ui: { custom, notify: vi.fn() },
    });

    expect(frames).toHaveLength(5);
    const dialog = frames[0];
    expect(dialog[1]).toContain("Context Usage");
    expect(dialog[1]).toContain("10.0k / 200k tokens (5.0%)");
    expect(dialog[1]).toContain("[esc]");
    expect(dialog[5]).toMatch(/^│› ■ System prompt/);
    expect(dialog[6]).toMatch(/^│ {2}■ Memory/);
    expect(dialog.map(visibleWidth)).toEqual(dialog.map(() => 64));

    expect(frames[1][1]).toContain("Memory Files");
    expect(frames[1].join("\n")).toContain("/p/AGENTS.md");
    expect(frames[2][6]).toMatch(/^│› ■ Memory/);
    expect(frames[3][1]).toContain("Skills");
    expect(frames[3].join("\n")).toContain("No skills in context.");
    expect(frames[4][7]).toMatch(/^│› ■ Skills/);
  });
});
