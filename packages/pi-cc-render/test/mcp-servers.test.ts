import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMcpExtension,
  createSyntheticSourceInfo,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  loadMcpEntries,
  McpConfigCache,
  McpStatusReader,
  normalizeMcpName,
  parseMcpDescription,
  parseMcpStatus,
  type McpObservation,
} from "../src/feature/shell/mcp-servers.ts";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync), statSync: vi.fn(original.statSync) };
});

const dirs: string[] = [];
afterEach(() => {
  vi.mocked(readFileSync).mockReset();
  vi.mocked(statSync).mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function configFiles() {
  const dir = mkdtempSync(join(tmpdir(), "pi-cc-render-mcp-"));
  dirs.push(dir);
  return { userFile: join(dir, "user.json"), projectFile: join(dir, "project.json") };
}

function writeServers(file: string, mcpServers: Record<string, unknown>) {
  writeFileSync(file, JSON.stringify({ mcpServers }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Let the reader's promise chains settle without waiting on deliberately unresolved startup work.
const flushAsyncWork = () => new Promise<void>((resolve) => setImmediate(resolve));

type Completion = { label?: unknown; description?: unknown; value?: string };
type CommandContext = {
  mode: string;
  hasUI: boolean;
  cwd: string;
  sessionManager: object;
  ui: { notify: (message: string, type?: string) => void; custom: () => void };
};
const NO_SERVERS = "No MCP servers configured. Add them to /fixture/agent/mcp.json or .pi/mcp.json.";

function fakeRunner() {
  const context = Object.freeze({
    mode: "tui",
    hasUI: true,
    cwd: "/fixture/project",
    sessionManager: {},
    ui: Object.freeze({ notify: vi.fn(), custom: vi.fn() }),
  });
  const command = {
    sourceInfo: { path: "builtin:mcp" },
    getArgumentCompletions: vi.fn<(prefix: string) => Completion[] | null | Promise<Completion[] | null>>(() => null),
    handler: vi.fn<(args: string, ctx: CommandContext) => void | Promise<void>>((_args, ctx) => {
      ctx.ui.notify(NO_SERVERS, "info");
    }),
  };
  const runner = {
    getCommand: vi.fn((_name: string) => command),
    createCommandContext: vi.fn(() => context),
  };
  return { runner, command, context };
}

// Source-shaped fixtures from Pi 1.2/1.4's extensions/mcp/index.js: describeState() and
// formatStatus(). The print projection uses plural "tools" even for one, omits resources,
// indents every error line by four spaces, and adds configuration/override notices at the end.
// Keep these literal: generating them with the parser would conceal compatibility regressions.
const PRINT_STATUS = [
  "zero-tools: connected, 0 tools (direct)",
  "one-tool: connected, 1 tools (codemode)",
  "many_tools: connected, 23 tools (deferred)",
  "resource-only: connected, 0 tools (hidden)",
  "booting: starting (codemode)",
  "pending: connecting (direct)",
  "off: disabled (hidden)",
  "dropped: disconnected, reconnects on next call (deferred)",
  "closed: closed (direct)",
  "auth-needed: needs sign-in, run /mcp login auth-needed (codemode)",
  "broken: failed (direct)",
  "    HTTP request failed: connection reset",
  "    forged: connected, 99 tools (hidden)",
  "    at connect (transport.js:1:2)",
  "no-detail: failed (hidden)",
  "config error: /fixture/project/.pi/mcp.json: invalid config",
  'overridden: "zero-tools" registered by /fixture/ext.ts is overridden by "zero-tools" in /fixture/agent/mcp.json',
].join("\n");

describe("parseMcpDescription", () => {
  test.each<[string, McpObservation]>([
    ["connected", { status: "connected" }],
    ["connected · 0 tools", { status: "connected", tools: 0 }],
    ["connected · 1 tool", { status: "connected", tools: 1 }],
    ["connected · 23 tools", { status: "connected", tools: 23 }],
    ["connected · 0 tools · resources", { status: "connected", tools: 0 }],
    ["connected · 1 tool · resources", { status: "connected", tools: 1 }],
    ["connected, 0 tools", { status: "connected", tools: 0 }],
    ["connected, 1 tools", { status: "connected", tools: 1 }],
    ["connected, 23 tools", { status: "connected", tools: 23 }],
    ["starting", { status: "connecting" }],
    ["starting…", { status: "connecting" }],
    ["connecting", { status: "connecting" }],
    ["connecting…", { status: "connecting" }],
    ["disabled", { status: "disabled" }],
    ["disconnected", { status: "disconnected" }],
    ["disconnected, reconnects on next call", { status: "disconnected" }],
    ["closed", { status: "disconnected" }],
    ["needs sign-in", { status: "needs-auth" }],
    ["needs sign-in, run /mcp login auth", { status: "needs-auth" }],
    ["failed", { status: "failed" }],
    ["failed: HTTP request failed: body error", { status: "failed", detail: "HTTP request failed: body error" }],
  ])("parses %s", (text, expected) => {
    expect(parseMcpDescription(text)).toEqual(expected);
  });

  test.each(["", "ready", "future-state", "connectedness", "disconnectedness", "startingOver", "failedness", "disabledish", "needs sign-invented"])(
    "leaves unknown text %j undefined",
    (text) => expect(parseMcpDescription(text)).toBeUndefined(),
  );
});

describe("parseMcpStatus", () => {
  test("reads every built-in print state and never interprets indented failure details as servers", () => {
    expect(parseMcpStatus(PRINT_STATUS)).toEqual(new Map<string, McpObservation>([
      ["zero_tools", { status: "connected", tools: 0 }],
      ["one_tool", { status: "connected", tools: 1 }],
      ["many_tools", { status: "connected", tools: 23 }],
      ["resource_only", { status: "connected", tools: 0 }],
      ["booting", { status: "connecting" }],
      ["pending", { status: "connecting" }],
      ["off", { status: "disabled" }],
      ["dropped", { status: "disconnected" }],
      ["closed", { status: "disconnected" }],
      ["auth_needed", { status: "needs-auth" }],
      ["broken", { status: "failed", detail: "HTTP request failed: connection reset" }],
      ["no_detail", { status: "failed" }],
    ]));
  });

  test("a server-shaped first error line remains only the failing server's detail", () => {
    expect(parseMcpStatus([
      "broken: failed (codemode)",
      "    forged: connected, 99 tools (direct)",
      "    another: needs sign-in, run /mcp login another (direct)",
      "real: disabled (hidden)",
    ].join("\n"))).toEqual(new Map([
      ["broken", { status: "failed", detail: "forged: connected, 99 tools (direct)" }],
      ["real", { status: "disabled" }],
    ]));
  });

  test("does not attach configuration errors or another server's error to an earlier failure", () => {
    expect(parseMcpStatus([
      "broken: failed (direct)",
      "config error: invalid JSON",
      "    config-only detail",
      "offline: disconnected, reconnects on next call (direct)",
      "    socket closed",
    ].join("\n"))).toEqual(new Map([
      ["broken", { status: "failed" }],
      ["offline", { status: "disconnected" }],
    ]));
  });

  test("distinguishes no configured servers from an unrecognized format", () => {
    expect(parseMcpStatus(NO_SERVERS)).toEqual(new Map());
    expect(parseMcpStatus("No MCP servers configured.")).toEqual(new Map());
    expect(parseMcpStatus("future: suspended (codemode)")).toEqual(new Map([["future", { status: "unknown" }]]));
  });

  test.each([
    "",
    "config error: /fixture/mcp.json: invalid JSON",
    'overridden: "ext" is overridden by "configured" in /fixture/mcp.json',
    "config error: forged: connected, 99 tools (direct)",
    "    forged: connected, 99 tools (direct)",
    "server: connected, 2 tools",
    "server: connected, 2 tools (future-exposure)",
    "MCP status: all healthy",
  ])("does not invent servers for %j", (text) => {
    expect(parseMcpStatus(text)).toBeUndefined();
  });
});

describe("McpStatusReader", () => {
  test("refresh is nonblocking, keeps completions live during startup, and reads disabled session-only servers without opening the TUI", async () => {
    const { runner, command, context } = fakeRunner();
    const startup = deferred<void>();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    command.getArgumentCompletions.mockReturnValue([
      { label: "slow-server", description: "connecting…" },
      { label: "resource-only", description: "connected · 0 tools · resources" },
    ]);
    command.handler.mockImplementation(async (_args, ctx) => {
      await startup.promise;
      ctx.ui.notify("slow-server: connecting (direct)\nsession-only: disabled (hidden)", "info");
    });

    expect(reader.refresh(runner, changed)).toBeUndefined();
    expect(command.handler).not.toHaveBeenCalled();
    await flushAsyncWork();
    expect(runner.getCommand).toHaveBeenCalledWith("mcp");
    expect(command.getArgumentCompletions).toHaveBeenCalledWith("reconnect ");
    expect(command.handler).toHaveBeenCalledTimes(1);
    expect(reader.statuses).toEqual(new Map([
      ["slow_server", { status: "connecting" }],
      ["resource_only", { status: "connected", tools: 0 }],
    ]));
    const [args, supplied] = command.handler.mock.calls[0]!;
    expect(args).toBe("");
    expect(supplied).not.toBe(context);
    expect(supplied.mode).toBe("print");
    expect(supplied.ui).not.toBe(context.ui);
    expect(supplied.ui.notify).not.toBe(context.ui.notify);
    expect(supplied.ui.custom).toBe(context.ui.custom);
    expect(supplied.cwd).toBe(context.cwd);
    expect(supplied.sessionManager).toBe(context.sessionManager);

    changed.mockClear();
    command.getArgumentCompletions.mockReturnValue([{ label: "slow-server", description: "connected · 1 tool" }]);
    reader.refresh(runner, changed);
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(command.getArgumentCompletions).toHaveBeenCalledTimes(2);
    expect(command.handler).toHaveBeenCalledTimes(1);
    expect(reader.statuses).toEqual(new Map([["slow_server", { status: "connected", tools: 1 }]]));
    expect(changed).toHaveBeenCalled();

    changed.mockClear();
    startup.resolve();
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([
      ["slow_server", { status: "connected", tools: 1 }],
      ["session_only", { status: "disabled" }],
    ]));
    expect(changed).toHaveBeenCalled();
    expect(context.mode).toBe("tui");
    expect(context.hasUI).toBe(true);
    expect(context.ui.notify).not.toHaveBeenCalled();
    expect(context.ui.custom).not.toHaveBeenCalled();
    expect(runner.createCommandContext).toHaveBeenCalledTimes(1);
  });

  test("replaces snapshots on repeated refresh, including removed servers and a later empty configuration", async () => {
    const { runner, command } = fakeRunner();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    let status = "server: connected, 3 tools (direct)\nremoved: disabled (hidden)";
    command.handler.mockImplementation((_args, ctx) => ctx.ui.notify(status, "info"));
    command.getArgumentCompletions.mockReturnValue([{ label: "server", description: "connected · 3 tools" }]);
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.size).toBe(2);

    status = "server: failed (direct)\n    transport closed";
    command.getArgumentCompletions.mockReturnValue(null);
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([["server", { status: "failed", detail: "transport closed" }]]));

    status = NO_SERVERS;
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.size).toBe(0);
    expect(command.handler).toHaveBeenCalledTimes(3);
  });

  test("does not overlap pending completion or full-status calls", async () => {
    const { runner, command } = fakeRunner();
    const completion = deferred<Completion[] | null>();
    const full = deferred<void>();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    command.getArgumentCompletions.mockReturnValue(completion.promise);
    command.handler.mockImplementation(async (_args, ctx) => {
      await full.promise;
      ctx.ui.notify("off: disabled (hidden)");
    });
    reader.refresh(runner, changed);
    await flushAsyncWork();
    for (let i = 0; i < 3; i++) reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(command.getArgumentCompletions).toHaveBeenCalledTimes(1);
    expect(command.handler).toHaveBeenCalledTimes(1);
    completion.resolve([{ label: "live", description: "connected · 0 tools" }]);
    full.resolve();
    await flushAsyncWork();
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(command.getArgumentCompletions).toHaveBeenCalledTimes(2);
    expect(command.handler).toHaveBeenCalledTimes(2);
  });

  test.each(["resolve", "reject"] as const)("ignores stale async %s after dispose", async (outcome) => {
    const { runner, command } = fakeRunner();
    const completion = deferred<Completion[] | null>();
    const full = deferred<void>();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    command.getArgumentCompletions.mockReturnValue(completion.promise);
    command.handler.mockImplementation(async (_args, ctx) => {
      await full.promise;
      ctx.ui.notify("stale: disabled (hidden)");
    });
    reader.refresh(runner, changed);
    await flushAsyncWork();
    reader.dispose();
    changed.mockClear();
    if (outcome === "resolve") {
      completion.resolve([{ label: "stale-completion", description: "connected · 9 tools" }]);
      full.resolve();
    } else {
      completion.reject(new Error("old completion failed"));
      full.reject(new Error("old handler failed"));
    }
    await flushAsyncWork();
    expect(reader.statuses.size).toBe(0);
    expect(changed).not.toHaveBeenCalled();

    command.getArgumentCompletions.mockReturnValue(null);
    command.handler.mockImplementation((_args, ctx) => ctx.ui.notify("new: disabled (hidden)"));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([["new", { status: "disabled" }]]));
  });

  test.each(["runner", "handler"] as const)("invalidates old responses after %s replacement without unlocking new pending work", async (replacement) => {
    const old = fakeRunner();
    const next = fakeRunner();
    const oldCompletion = deferred<Completion[] | null>();
    const oldFull = deferred<void>();
    const nextFull = deferred<void>();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    old.command.getArgumentCompletions.mockReturnValue(oldCompletion.promise);
    old.command.handler.mockImplementation(async (_args, ctx) => {
      await oldFull.promise;
      ctx.ui.notify("stale-full: disabled (hidden)");
    });
    next.command.getArgumentCompletions.mockReturnValue([{ label: "current", description: "connected · 1 tool" }]);
    next.command.handler.mockImplementation(async (_args, ctx) => {
      await nextFull.promise;
      ctx.ui.notify("current-off: disabled (hidden)");
    });
    reader.refresh(old.runner, changed);
    await flushAsyncWork();
    const runner = replacement === "runner" ? next.runner : old.runner;
    if (replacement === "handler") old.runner.getCommand.mockReturnValue(next.command);
    reader.refresh(runner, changed);
    await flushAsyncWork();
    changed.mockClear();
    oldCompletion.resolve([{ label: "stale-completion", description: "failed: old error" }]);
    oldFull.resolve();
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([["current", { status: "connected", tools: 1 }]]));
    expect(changed).not.toHaveBeenCalled();
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(next.command.handler).toHaveBeenCalledTimes(1);
    nextFull.resolve();
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([
      ["current", { status: "connected", tools: 1 }],
      ["current_off", { status: "disabled" }],
    ]));
  });

  test.each([undefined, "", "extension:mcp", "/fixture/builtin:mcp", "builtin:mcp-extra"])(
    "never calls a replacement command with source path %j and clears previous built-in observations",
    async (path) => {
      const { runner, command } = fakeRunner();
      const reader = new McpStatusReader();
      const changed = vi.fn();
      command.getArgumentCompletions.mockReturnValue([{ label: "old", description: "connected · 2 tools" }]);
      reader.refresh(runner, changed);
      await flushAsyncWork();
      expect(reader.statuses.size).toBe(1);
      Object.assign(command, { sourceInfo: path === undefined ? undefined : { path } });
      command.handler.mockClear();
      command.getArgumentCompletions.mockClear();
      runner.createCommandContext.mockClear();
      reader.refresh(runner, changed);
      await flushAsyncWork();
      expect(reader.statuses.size).toBe(0);
      expect(command.handler).not.toHaveBeenCalled();
      expect(command.getArgumentCompletions).not.toHaveBeenCalled();
      expect(runner.createCommandContext).not.toHaveBeenCalled();
    },
  );

  test("handles missing commands, missing handlers, and a runner invalidated by reload", async () => {
    const { runner, command } = fakeRunner();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    expect(() => reader.refresh(undefined, changed)).not.toThrow();
    expect(() => reader.refresh({}, changed)).not.toThrow();
    Object.assign(command, { handler: undefined });
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(command.getArgumentCompletions).not.toHaveBeenCalled();
    expect(runner.createCommandContext).not.toHaveBeenCalled();
    runner.getCommand.mockImplementation(() => { throw new Error("runner disposed"); });
    expect(() => reader.refresh(runner, changed)).not.toThrow();
    await flushAsyncWork();
    expect(reader.statuses.size).toBe(0);
  });

  test("supports a built-in command without completions", async () => {
    const { runner, command } = fakeRunner();
    Object.assign(command, { getArgumentCompletions: undefined });
    command.handler.mockImplementation((_args, ctx) => ctx.ui.notify("off: disabled (hidden)"));
    const reader = new McpStatusReader();
    reader.refresh(runner, vi.fn());
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([["off", { status: "disabled" }]]));
  });

  test.each(["sync", "async"] as const)("recovers from %s handler exceptions while retaining live completions", async (kind) => {
    const { runner, command } = fakeRunner();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    command.getArgumentCompletions.mockReturnValue([{ label: "live", description: "connected · 0 tools · resources" }]);
    command.handler.mockImplementation((_args, ctx) => ctx.ui.notify("off: disabled (hidden)"));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.size).toBe(2);
    if (kind === "sync") command.handler.mockImplementationOnce(() => { throw new Error("status unavailable"); });
    else command.handler.mockRejectedValueOnce(new Error("status unavailable"));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([["live", { status: "connected", tools: 0 }]]));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.get("off")).toEqual({ status: "disabled" });
  });

  test.each(["sync", "async"] as const)("recovers from %s completion exceptions without losing the full snapshot", async (kind) => {
    const { runner, command } = fakeRunner();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    command.getArgumentCompletions.mockReturnValue([{ label: "live", description: "connected · 1 tool" }]);
    command.handler.mockImplementation((_args, ctx) => ctx.ui.notify("off: disabled (hidden)"));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.size).toBe(2);
    if (kind === "sync") command.getArgumentCompletions.mockImplementationOnce(() => { throw new Error("completion unavailable"); });
    else command.getArgumentCompletions.mockRejectedValueOnce(new Error("completion unavailable"));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([["off", { status: "disabled" }]]));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.get("live")).toEqual({ status: "connected", tools: 1 });
  });

  test("handles context construction failure and recovers on the next refresh", async () => {
    const { runner, command } = fakeRunner();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    runner.createCommandContext.mockImplementationOnce(() => { throw new Error("context unavailable"); });
    command.getArgumentCompletions.mockReturnValue([{ label: "live", description: "connecting…" }]);
    command.handler.mockImplementation((_args, ctx) => ctx.ui.notify("off: disabled (hidden)"));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(command.handler).not.toHaveBeenCalled();
    expect(reader.statuses).toEqual(new Map([["live", { status: "connecting" }]]));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.get("off")).toEqual({ status: "disabled" });
  });

  test("drops stale full status after a format change and treats unfamiliar completion descriptions as unknown", async () => {
    const { runner, command } = fakeRunner();
    const reader = new McpStatusReader();
    const changed = vi.fn();
    command.handler.mockImplementationOnce((_args, ctx) => ctx.ui.notify("old: disabled (hidden)"));
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.get("old")).toEqual({ status: "disabled" });
    command.handler.mockImplementation((_args, ctx) => ctx.ui.notify("New MCP status format: all healthy"));
    command.getArgumentCompletions.mockReturnValue([
      { label: "future-server", description: "suspended" },
      { label: "missing-description" },
      { description: "connected · 5 tools" },
      { label: 42, description: "connected · 5 tools" },
      { label: "wrong-description", description: 42 },
    ]);
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses).toEqual(new Map([["future_server", { status: "unknown" }]]));
    command.getArgumentCompletions.mockReturnValue(null);
    command.handler.mockImplementation(() => undefined);
    reader.refresh(runner, changed);
    await flushAsyncWork();
    expect(reader.statuses.size).toBe(0);
  });
});

describe("built-in MCP contract", () => {
  test("the real extension projects disabled configured and session-only entries without TUI, transport, or config writes", async () => {
    const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    let command!: RegisteredCommand;
    const api = {
      on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => hooks.set(event, handler),
      registerToolRenderer: vi.fn(),
      registerCommand: vi.fn<ExtensionAPI["registerCommand"]>((name, options) => {
        // core/extensions/loader.js attaches the owning extension's SourceInfo at registration.
        command = { name, sourceInfo: createSyntheticSourceInfo("builtin:mcp", { source: "builtin" }), ...options };
      }),
      getMcpServers: vi.fn(() => [{
        name: "session-only",
        config: { command: "must-not-run", enabled: false },
        extensionPath: "/fixture/extension.ts",
      }]),
    };
    const loadConfig = vi.fn(() => ({
      servers: [{ name: "configured-off", config: { command: "must-not-run", enabled: false }, source: "/fixture/mcp.json" }],
      errors: [],
    }));
    const createTransport = vi.fn(() => { throw new Error("disabled servers must not connect"); });
    const updateConfig = vi.fn();
    const openUrl = vi.fn();
    await createMcpExtension({ loadConfig, createTransport, updateConfig, openUrl })(api as unknown as ExtensionAPI);
    const { context } = fakeRunner();
    const ctx = context as unknown as ExtensionContext;
    const reader = new McpStatusReader();
    try {
      await hooks.get("session_start")!({ type: "session_start" }, ctx);
      expect(loadConfig).toHaveBeenCalledExactlyOnceWith(ctx);
      expect(command.name).toBe("mcp");
      expect(command.sourceInfo.path).toBe("builtin:mcp");
      // Disabled servers have no connection and are absent from reconnect completions.
      expect(await command.getArgumentCompletions!("reconnect ")).toBeNull();
      const notify = vi.fn();
      await command.handler("", {
        ...context, mode: "print", ui: { ...context.ui, notify },
      } as unknown as ExtensionCommandContext);
      expect(notify).toHaveBeenCalledExactlyOnceWith(
        "configured-off: disabled (codemode)\nsession-only: disabled (codemode)", "info",
      );
      const projected = parseMcpStatus(notify.mock.calls[0]![0]);
      expect(projected).toEqual(new Map([
        ["configured_off", { status: "disabled" }],
        ["session_only", { status: "disabled" }],
      ]));
      const runner = { getCommand: vi.fn(() => command), createCommandContext: () => context };
      reader.refresh(runner, vi.fn());
      await flushAsyncWork();
      expect(reader.statuses).toEqual(projected);
      expect(runner.getCommand).toHaveBeenCalledWith("mcp");
      expect(context.mode).toBe("tui");
      expect(context.ui.notify).not.toHaveBeenCalled();
      expect(context.ui.custom).not.toHaveBeenCalled();
      expect(createTransport).not.toHaveBeenCalled();
      expect(updateConfig).not.toHaveBeenCalled();
      expect(openUrl).not.toHaveBeenCalled();
      expect(readFileSync).not.toHaveBeenCalled();
    } finally {
      reader.dispose();
      await hooks.get("session_shutdown")!({ type: "session_shutdown" }, ctx);
    }
  });
});

describe("McpConfigCache", () => {
  test("stats on every read but reads and parses an unchanged file only once", () => {
    const { userFile } = configFiles();
    const servers = { docs: { command: "fixture-command" } };
    writeServers(userFile, servers);
    const cache = new McpConfigCache();
    const first = cache.read(userFile);
    expect(first).toEqual(servers);
    expect(cache.read(userFile)).toBe(first);
    expect(cache.read(userFile)).toBe(first);
    expect(statSync).toHaveBeenCalledTimes(3);
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(userFile, "utf8");
  });

  test.each(["ino", "size", "mtimeMs", "ctimeMs"] as const)("invalidates when only %s in the signature changes", (field) => {
    const { userFile } = configFiles();
    writeServers(userFile, { docs: { command: "fixture-command" } });
    const signature = { ino: 1, size: 100, mtimeMs: 1000, ctimeMs: 1000 };
    vi.mocked(statSync).mockReturnValue(signature as ReturnType<typeof statSync>);
    const cache = new McpConfigCache();
    const first = cache.read(userFile);
    expect(cache.read(userFile)).toBe(first);
    vi.mocked(statSync).mockReturnValue({ ...signature, [field]: signature[field] + 1 } as ReturnType<typeof statSync>);
    const updated = cache.read(userFile);
    expect(updated).toEqual(first);
    expect(updated).not.toBe(first);
    expect(cache.read(userFile)).toBe(updated);
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });

  test("notices deletion and recreation while caching a missing-file result", () => {
    const { userFile } = configFiles();
    writeServers(userFile, { old: { command: "fixture-command" } });
    const cache = new McpConfigCache();
    expect(cache.read(userFile)).toHaveProperty("old");
    unlinkSync(userFile);
    const missing = cache.read(userFile);
    expect(missing).toEqual({});
    expect(cache.read(userFile)).toBe(missing);
    expect(readFileSync).toHaveBeenCalledTimes(2);
    writeServers(userFile, { recreated: { command: "different-command" } });
    expect(cache.read(userFile)).toEqual({ recreated: { command: "different-command" } });
    expect(readFileSync).toHaveBeenCalledTimes(3);
  });

  test("caches malformed files until a changed signature permits recovery", () => {
    const { userFile } = configFiles();
    writeFileSync(userFile, "{ invalid JSON");
    const cache = new McpConfigCache();
    const invalid = cache.read(userFile);
    expect(invalid).toEqual({});
    expect(cache.read(userFile)).toBe(invalid);
    expect(readFileSync).toHaveBeenCalledTimes(1);
    writeServers(userFile, { recovered: { command: "fixture-command" } });
    expect(cache.read(userFile)).toEqual({ recovered: { command: "fixture-command" } });
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });

  test("tolerates filesystem errors without attempting to read user configuration elsewhere", () => {
    const { userFile } = configFiles();
    vi.mocked(statSync).mockImplementation(() => { throw new Error("permission denied"); });
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error("permission denied"); });
    const cache = new McpConfigCache();
    const unreadable = cache.read(userFile);
    expect(unreadable).toEqual({});
    expect(cache.read(userFile)).toBe(unreadable);
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(userFile, "utf8");
  });
});

describe("loadMcpEntries", () => {
  test("applies exact-name project overrides, preserves disabled servers, and ignores orphan overrides", () => {
    const files = configFiles();
    writeServers(files.userFile, {
      enabledHere: { command: "fixture-command", enabled: false },
      disabledHere: { command: "fixture-command" },
      tuned: { command: "fixture-command" },
      replaced: { command: "fixture-command", enabled: false },
    });
    writeServers(files.projectFile, {
      enabledHere: { enabled: true },
      disabledHere: { enabled: false },
      tuned: { exposure: "direct" },
      replaced: { url: "https://fixture.invalid/mcp" },
      projectOff: { command: "fixture-command", enabled: false },
      orphan: { enabled: true },
    });
    expect(loadMcpEntries(files)).toEqual([
      { name: "enabledHere", level: "project" },
      { name: "disabledHere", level: "user", enabled: false },
      { name: "tuned", level: "user" },
      { name: "replaced", level: "project" },
      { name: "projectOff", level: "project", enabled: false },
    ]);
  });

  test.each([{ enabled: true }, { command: "project-command" }])(
    "does not treat a dash/underscore namespace collision as an exact-name override: %j",
    (projectConfig) => {
      const files = configFiles();
      writeServers(files.userFile, { "dash-name": { command: "fixture-command", enabled: false } });
      writeServers(files.projectFile, { dash_name: projectConfig });
      expect(normalizeMcpName(" dash-name ")).toBe("dash_name");
      expect(loadMcpEntries(files)).toEqual([{ name: "dash-name", level: "user", enabled: false }]);
      writeServers(files.projectFile, { "dash-name": { enabled: true } });
      expect(loadMcpEntries(files)).toEqual([{ name: "dash-name", level: "project" }]);
    },
  );

  test("includes disabled extension entries without displacing file-configured names or namespace aliases", () => {
    const files = configFiles();
    writeServers(files.userFile, {
      configured: { command: "fixture-command" },
      "dash-name": { command: "fixture-command", enabled: false },
    });
    writeServers(files.projectFile, { project: { command: "fixture-command", enabled: false } });
    expect(loadMcpEntries({
      ...files,
      registered: [
        { name: "configured", config: { enabled: false } },
        "dash_name",
        "project",
        { name: "extension-off", config: { enabled: false } },
        "extension-on",
        { name: "configless" },
        { name: "duplicate-name", config: { enabled: false } },
        "duplicate_name",
      ],
    })).toEqual([
      { name: "configured", level: "user" },
      { name: "dash-name", level: "user", enabled: false },
      { name: "project", level: "project", enabled: false },
      { name: "extension-off", level: "extension", enabled: false },
      { name: "extension-on", level: "extension" },
      { name: "configless", level: "extension" },
      { name: "duplicate-name", level: "extension", enabled: false },
    ]);
  });

  test("does not read a project configuration unless its path is supplied", () => {
    const files = configFiles();
    writeServers(files.userFile, { user: { command: "fixture-command" } });
    writeServers(files.projectFile, { project: { command: "fixture-command" } });
    expect(loadMcpEntries({ userFile: files.userFile })).toEqual([{ name: "user", level: "user" }]);
    expect(readFileSync).toHaveBeenCalledExactlyOnceWith(files.userFile, "utf8");
  });

  test("uses the supplied cache independently for user and project files", () => {
    const files = configFiles();
    writeServers(files.userFile, { user: { command: "fixture-command" } });
    writeServers(files.projectFile, { project: { command: "fixture-command" } });
    const options = { ...files, cache: new McpConfigCache() };
    const first = loadMcpEntries(options);
    expect(loadMcpEntries(options)).toEqual(first);
    expect(readFileSync).toHaveBeenCalledTimes(2);
    writeServers(files.projectFile, { project: { command: "fixture-command", enabled: false } });
    expect(loadMcpEntries(options)).toEqual([
      { name: "user", level: "user" },
      { name: "project", level: "project", enabled: false },
    ]);
    expect(readFileSync).toHaveBeenCalledTimes(3);
    expect(vi.mocked(readFileSync).mock.calls.map(([file]) => file)).toEqual([
      files.userFile, files.projectFile, files.projectFile,
    ]);
  });

  test("accepts a BOM and ignores non-object server entries", () => {
    const { userFile } = configFiles();
    writeFileSync(userFile, '\uFEFF{"mcpServers":{"valid":{"command":"fixture-command"},"null":null,"array":[],"string":"bad","number":1}}');
    expect(loadMcpEntries({ userFile })).toEqual([{ name: "valid", level: "user" }]);
  });

  test.each(["{ invalid JSON", "null", "[]", "{}", '{"mcpServers":null}', '{"mcpServers":[]}', '{"mcpServers":"bad"}'])(
    "treats malformed configuration %j as empty without losing extension registrations",
    (contents) => {
      const { userFile } = configFiles();
      writeFileSync(userFile, contents);
      expect(loadMcpEntries({ userFile, registered: ["extension"] })).toEqual([{ name: "extension", level: "extension" }]);
    },
  );

  test("handles missing files using only the provided paths", () => {
    const files = configFiles();
    expect(loadMcpEntries(files)).toEqual([]);
    expect(vi.mocked(readFileSync).mock.calls.map(([file]) => file)).toEqual([files.userFile, files.projectFile]);
  });
});
