// A minimal fake of Pi's extension API: records handlers, commands, entries and UI calls.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Settings files of the machine running the tests must not leak in: point the user-level config
// directories at an empty temp directory.
const isolated = mkdtempSync(path.join(tmpdir(), "auto-effort-test-"));
process.env.XDG_CONFIG_HOME = path.join(isolated, "xdg");
process.env.PI_CODING_AGENT_DIR = path.join(isolated, "pi");
type Handler = (event: any, ctx: any) => unknown;

export interface FakeJev {
  calls: Array<{ state: Record<string, unknown>; questions: Record<string, any>; options: any }>;
  answer: (questions: Record<string, any>, state: Record<string, unknown>) => any;
}

export function fakeJev(answer: FakeJev["answer"]): FakeJev & { registry: unknown } {
  const calls: FakeJev["calls"] = [];
  const registry = {
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id }),
    classify: async (_model: unknown, context: any, options: any) => {
      calls.push({ state: context.state, questions: context.questions, options });
      const result = answer(context.questions, context.state);
      if (result && typeof result === "object" && "stopReason" in result) return result;
      return { model: "jev-latest", stopReason: "stop", answers: result, usage: usage(300) };
    },
  };
  return { calls, answer, registry };
}

export function usage(input: number) {
  return { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Depth answers by preset (0 trivial, 1 routine, 2 multi-step, 3 hard) or explicit [low, medium, high, xhigh] probabilities. */
export const DEPTH: Record<number, number[]> = {
  // need(medium) 0.15
  0: [0.85, 0.1, 0.04, 0.01],
  // need(medium) 0.85, need(high) 0.15
  1: [0.15, 0.7, 0.1, 0.05],
  // need(high) 0.75, need(xhigh) 0.15
  2: [0.05, 0.2, 0.6, 0.15],
  // need(high) 0.95, need(xhigh) 0.7
  3: [0.02, 0.03, 0.25, 0.7],
};

export function depthAnswer(depth: number | number[]) {
  const p = Array.isArray(depth) ? depth : DEPTH[depth]!;
  const levels = ["low", "medium", "high", "xhigh"];
  const probabilities = Object.fromEntries(levels.map((l, i) => [l, p[i] ?? 0]));
  const best = p.indexOf(Math.max(...p));
  return { type: "choice", choice: levels[best], probabilities, confidence: p[best] };
}

export function answers(depth: number | number[], ack = 0.05, extra: Record<string, unknown> = {}) {
  return { depth: depthAnswer(depth), ack: { type: "bool", probability: ack }, ...extra };
}

export function tierAnswer(probabilities: Record<string, number>) {
  const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? ["?"];
  return { type: "choice", choice, probabilities, confidence: Math.max(...Object.values(probabilities)) };
}

export function harness(options: { tools?: any[]; exec?: (cmd: string, args: string[]) => any } = {}) {
  const handlers = new Map<string, Handler[]>();
  const events: Array<{ channel: string; data: any }> = [];
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const modelChanges: any[] = [];
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const messages: any[] = [];
  let thinking = "high";
  const thinkingChanges: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerShortcut: (key: string, options: any) => shortcuts.set(key, options),
    registerTool: () => undefined,
    registerFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    registerEntryRenderer: () => undefined,
    getFlag: () => undefined,
    getAllTools: () => options.tools ?? [],
    exec: async (cmd: string, args: string[]) => options.exec?.(cmd, args) ?? { code: 1, stdout: "", stderr: "", killed: false },
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
    sendMessage: (message: any, opts: any) => messages.push({ message, opts }),
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: string) => {
      thinking = level;
      thinkingChanges.push(level);
      void emit("thinking_level_select", { type: "thinking_level_select", level, previousLevel: "?" });
    },
    events: {
      emit: (channel: string, data: unknown) => {
        events.push({ channel, data });
        for (const listener of listeners.get(channel) ?? []) listener(data);
      },
      on: (channel: string, listener: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
        return () => undefined;
      },
    },
    setModel: async (model: any) => {
      const previousModel = lastCtx?.model;
      if (lastCtx) lastCtx.model = model;
      modelChanges.push(model);
      await emit("model_select", { type: "model_select", model, previousModel, source: "set" });
      return true;
    },
  };
  async function emit(event: string, payload: any, ctx?: any) {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx ?? lastCtx)) ?? result;
    return result;
  }
  let lastCtx: any;
  function ctx(overrides: Record<string, unknown> = {}) {
    const ui = {
      selects: [] as Array<{ title: string; options: string[] }>,
      selectAnswers: [] as Array<string | undefined>,
      inputAnswers: [] as Array<string | undefined>,
      notes: [] as Array<{ message: string; type?: string }>,
      status: new Map<string, string | undefined>(),
      select: async (title: string, opts: string[]) => {
        ui.selects.push({ title, options: opts });
        return ui.selectAnswers.shift();
      },
      input: async () => ui.inputAnswers.shift(),
      confirm: async () => true,
      notify: (message: string, type?: string) => ui.notes.push({ message, type }),
      setStatus: (key: string, text: string | undefined) => ui.status.set(key, text),
      custom: async () => undefined,
    };
    lastCtx = {
      cwd: "/Users/me/Projects/app",
      hasUI: true,
      mode: "tui",
      ui,
      signal: undefined,
      sessionManager: { getBranch: () => [], getSessionId: () => "session-1" },
      modelRegistry: undefined,
      ...overrides,
    };
    return lastCtx;
  }
  return { pi: pi as any, handlers, commands, shortcuts, entries, messages, events, modelChanges, emit, ctx, thinkingChanges, get thinking() { return thinking; } };
}

export function userEntry(text: string) {
  return { type: "message", id: `u${Math.random()}`, message: { role: "user", content: text } };
}

export function assistantEntry(text: string) {
  return { type: "message", id: `a${Math.random()}`, message: { role: "assistant", content: [{ type: "text", text }] } };
}
