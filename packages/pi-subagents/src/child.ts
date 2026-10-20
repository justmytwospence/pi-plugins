// One subagent: a `pi --mode rpc` child process with its own context window. The task is sent as a
// prompt; the run ends at `agent_settled`, when stdin is closed so Pi shuts down in order. RPC keeps
// the child steerable, and its extension dialogs (for example a tool gate asking for approval) are
// cancelled and reported as blockers instead of interrupting the user. Every event feeds the viewer.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Conversation, type Message, describeTool } from "./conversation.ts";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function addUsage(a: Usage, b: Partial<Usage> | undefined): Usage {
  if (!b) return a;
  const c = (b.cost ?? {}) as Partial<Usage["cost"]>;
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
    totalTokens: a.totalTokens + (b.totalTokens ?? 0),
    cost: {
      input: a.cost.input + (c.input ?? 0),
      output: a.cost.output + (c.output ?? 0),
      cacheRead: a.cost.cacheRead + (c.cacheRead ?? 0),
      cacheWrite: a.cost.cacheWrite + (c.cacheWrite ?? 0),
      total: a.cost.total + (c.total ?? 0),
    },
  };
}

export type ChildStatus = "running" | "done" | "failed" | "stopped";

export interface ChildState {
  status: ChildStatus;
  /** Native session path reported by Pi's get_state (never inferred). */
  sessionFile?: string;
  /** The child's last assistant text. */
  output: string;
  usage: Usage;
  turns: number;
  /** The model that answered, as Pi reports it. */
  model?: string;
  /** What the child is doing now, e.g. `bash: npm test`. */
  activity?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

export interface DialogRequest {
  method: "select" | "confirm" | "input" | "editor";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
}

/** The value for an `extension_ui_response`, or undefined to cancel. */
export type DialogAnswer = { value: string } | { confirmed: boolean } | undefined;

export interface ChildOptions {
  task: string;
  cwd: string;
  model: string;
  thinking: string;
  tools?: string[];
  systemPrompt?: string;
  /** At this many turns the child is told to wrap up; if it calls tools again, it is stopped. */
  maxTurns?: number;
  /** Session file to fork, for `context: "fork"`. */
  forkSession?: string;
  sessionDir: string;
  onUpdate?: (state: ChildState) => void;
  onDialog?: (request: DialogRequest) => Promise<DialogAnswer>;
  /** Each finished message, for example to save it. */
  onMessage?: (message: Message) => void;
  /** Prompt-cache TTL for the child (`PI_CACHE_RETENTION`); `inherit` (the default) keeps the parent's. */
  cacheRetention?: CacheRetention;
  /** Command and leading args to run Pi; defaults to the running Pi. */
  invocation?: { command: string; args: string[] };
  /** Extra environment for the child (from the subagent-env contract). */
  env?: Record<string, string>;
}

/**
 * Optional contract: before a child starts, this package asks this `pi.events` channel for extra
 * environment (`{ version: 1, env }`; listeners add entries to `env`). pi-sidebar uses it to run
 * its read-only guard inside the subagents Sidebar starts. A probe (`{ version: 1, env, probe: true }`)
 * gets `supported: true`, so a listener can tell the contract is honored.
 */
export const SUBAGENT_ENV_CHANNEL = "pi-plugins.subagent-env.v1";

export interface SubagentEnvRequest {
  version: 1;
  env: Record<string, string>;
  probe?: boolean;
  supported?: boolean;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Extra environment listeners add for a child about to start; never throws. */
export function requestSubagentEnv(events: { emit(channel: string, data: unknown): void } | undefined): Record<string, string> {
  const request: SubagentEnvRequest = { version: 1, env: {} };
  try {
    events?.emit(SUBAGENT_ENV_CHANNEL, request);
  } catch {
    return {};
  }
  return Object.fromEntries(Object.entries(request.env).filter(([key, value]) => ENV_NAME.test(key) && typeof value === "string"));
}

/** Answer probes on the contract channel, so listeners know subagents will get their env. */
export function answerSubagentEnvProbes(events: { on(channel: string, handler: (data: unknown) => void): unknown }): void {
  events.on(SUBAGENT_ENV_CHANNEL, (data) => {
    const request = data as Partial<SubagentEnvRequest> | undefined;
    if (request?.version === 1 && request.probe) request.supported = true;
  });
}

export const CACHE_RETENTIONS = ["short", "long", "inherit"] as const;
export type CacheRetention = (typeof CACHE_RETENTIONS)[number];

/**
 * The child's environment: the parent's, marked as a subagent one level deeper, with
 * `PI_CACHE_RETENTION` set unless `retention` is `inherit` (or not a known value).
 */
export function childEnv(retention: CacheRetention = "inherit", env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, PI_SUBAGENT: "1", PI_SUBAGENT_DEPTH: String(subagentDepth(env) + 1) };
  if (retention === "short" || retention === "long") out.PI_CACHE_RETENTION = retention;
  return out;
}

/** How deep this Pi is in a tree of subagents: 0 for a top-level session, 1 for its children. */
export function subagentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const depth = Number(env.PI_SUBAGENT_DEPTH);
  if (Number.isInteger(depth) && depth >= 0) return depth;
  return env.PI_SUBAGENT ? 1 : 0;
}

let invocationOverride: { command: string; args: string[] } | undefined;

/** Run children with another command (tests use a fake Pi); undefined restores the default. */
export function setPiInvocation(invocation: { command: string; args: string[] } | undefined) {
  invocationOverride = invocation;
}

/** How to run the same Pi that is running this extension. */
export function piInvocation(): { command: string; args: string[] } {
  if (invocationOverride) return invocationOverride;
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: process.execPath, args: [script] };
  const exec = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/u.test(exec)) return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

/** Human-led workflows must not be reachable by a report-back worker, even via codemode. */
export const HEADLESS_EXCLUDED_TOOLS = ["enter_plan_mode", "exit_plan_mode", "ask_user_question", "herdr_child"];
export const HEADLESS_PROMPT = "You are a headless report-back worker, not a human-led session. Execute the assigned task within its scope. Do not enter plan mode, request user approval, ask the user questions, or start interactive agents. If a decision or permission is needed, stop and report the blocker to the parent agent; never grant yourself permission. Return your findings and changes to the parent.";

export function childArgs(options: ChildOptions, promptFile?: string): string[] {
  const args = ["--mode", "rpc"];
  if (options.forkSession) args.push("--fork", options.forkSession);
  args.push("--session-dir", options.sessionDir);
  args.push("--model", options.model, "--thinking", options.thinking);
  if (options.tools?.length) args.push("--tools", options.tools.join(","));
  args.push("--exclude-tools", HEADLESS_EXCLUDED_TOOLS.join(","));
  if (promptFile) args.push("--append-system-prompt", promptFile);
  return args;
}

/** Session discovery is best-effort: an older/unresponsive RPC child must still receive its task. */
export const STARTUP_STATE_TIMEOUT_MS = 10_000;

export class Child {
  readonly state: ChildState;
  readonly done: Promise<ChildState>;
  readonly conversation: Conversation;
  private proc: ChildProcess | undefined;
  private settle!: (state: ChildState) => void;
  private stderr = "";
  private stopping = false;
  private started = false;
  private startupState?: { id: string; timer: ReturnType<typeof setTimeout> };

  constructor(private readonly options: ChildOptions) {
    this.state = { status: "running", output: "", usage: emptyUsage(), turns: 0, startedAt: Date.now() };
    this.conversation = new Conversation(options.onMessage);
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  start(): this {
    // stop-before-start and repeated starts must never create a late/duplicate process.
    if (this.started || this.stopping || this.state.status !== "running") return this;
    this.started = true;
    let promptFile: string | undefined;
    const dir = mkdtempSync(path.join(tmpdir(), "pi-subagent-"));
    promptFile = path.join(dir, "agent.md");
    writeFileSync(promptFile, [this.options.systemPrompt?.trim(), HEADLESS_PROMPT].filter(Boolean).join("\n\n"), { mode: 0o600 });
    const invocation = this.options.invocation ?? piInvocation();
    const proc = spawn(invocation.command, [...invocation.args, ...childArgs(this.options, promptFile)], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...childEnv(this.options.cacheRetention), ...(this.options.env ?? {}) },
    });
    this.proc = proc;
    let buffer = "";
    proc.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) this.onLine(line);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      this.stderr = (this.stderr + data.toString()).slice(-4_000);
    });
    const failed = (error: Error) => this.finishAndClose(this.stopping ? "stopped" : "failed", this.stopping ? undefined : error.message);
    proc.on("error", failed);
    // In particular, an exit while the startup command is being written can cause EPIPE.
    proc.stdin?.on("error", failed);
    proc.on("close", (code) => {
      if (buffer.trim()) this.onLine(buffer);
      if (this.state.status === "running") {
        this.finish(this.stopping ? "stopped" : "failed", this.stopping ? undefined : `pi exited (${code ?? "signal"})${this.stderr.trim() ? `: ${this.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`);
      }
    });
    // Fresh and CLI-forked sessions already have a path when RPC starts, before the first prompt.
    // Wait for this specific response, not an unrelated response or a guessed filename.
    const id = randomUUID();
    const timer = setTimeout(() => this.promptAfterStartup(), STARTUP_STATE_TIMEOUT_MS);
    timer.unref?.();
    this.startupState = { id, timer };
    this.send({ type: "get_state", id });
    return this;
  }

  private clearStartup() {
    if (this.startupState) clearTimeout(this.startupState.timer);
    this.startupState = undefined;
  }

  private promptAfterStartup() {
    this.clearStartup();
    if (!this.stopping && this.state.status === "running") this.send({ type: "prompt", message: this.options.task });
  }

  steer(message: string): boolean {
    if (this.stopping || this.state.status !== "running") return false;
    this.send({ type: "steer", message });
    return true;
  }

  stop() {
    if (this.state.status !== "running") return;
    this.stopping = true;
    this.clearStartup();
    if (!this.started) {
      this.finish("stopped");
      return;
    }
    this.send({ type: "abort" });
    this.proc?.stdin?.end();
    const proc = this.proc;
    setTimeout(() => {
      if (proc && proc.exitCode === null) proc.kill("SIGTERM");
    }, 3_000).unref?.();
  }

  private send(command: Record<string, unknown>) {
    const stdin = this.proc?.stdin;
    if (stdin && !stdin.destroyed && !stdin.writableEnded && stdin.writable) stdin.write(`${JSON.stringify(command)}\n`);
  }

  private update() {
    this.options.onUpdate?.(this.state);
  }

  private finish(status: ChildStatus, error?: string) {
    if (this.state.status !== "running") return;
    this.clearStartup();
    this.state.status = status;
    this.state.endedAt = Date.now();
    this.state.activity = undefined;
    if (error) this.state.error = error;
    this.conversation.close();
    this.update();
    this.settle(this.state);
  }

  private onLine(line: string) {
    if (!line.trim()) return;
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    this.conversation.apply(event);
    switch (event.type) {
      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") break;
        this.state.turns++;
        this.state.usage = addUsage(this.state.usage, message.usage);
        if (message.model) this.state.model = `${message.provider ? `${message.provider}/` : ""}${message.model}`;
        const text = Array.isArray(message.content)
          ? message.content.filter((b: { type?: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n").trim()
          : "";
        if (text) this.state.output = text;
        if (message.stopReason === "error" && message.errorMessage) this.state.error = message.errorMessage;
        this.update();
        this.checkTurnLimit(message.stopReason);
        break;
      }
      case "tool_execution_start":
        this.state.activity = describeTool(event.toolName, event.args);
        this.update();
        break;
      case "tool_execution_end": {
        // Another tool may still be running in parallel.
        const still = [...this.conversation.activeTools.values()].at(-1);
        this.state.activity = still ? describeTool(still.name, still.args) : undefined;
        this.update();
        break;
      }
      case "response":
        if (event.command === "get_state" && this.startupState && event.id === this.startupState.id) {
          this.clearStartup();
          if (event.success === true && typeof event.data?.sessionFile === "string" && event.data.sessionFile.trim()) {
            this.state.sessionFile = event.data.sessionFile;
            this.update();
          }
          // A rejected state query is only missing metadata, not a failed task.
          this.promptAfterStartup();
        } else if (event.command === "prompt" && event.success === false) {
          this.finishAndClose(this.stopping ? "stopped" : "failed", this.stopping ? undefined : String(event.error ?? "the prompt was rejected"));
        } else if (event.command === "prompt" && event.data?.disposition === "handled") {
          this.finishAndClose(this.stopping ? "stopped" : "done");
        }
        break;
      case "agent_settled":
        // After stop(), Pi settles the aborted run before it exits.
        this.finishAndClose(this.stopping ? "stopped" : this.state.error ? "failed" : "done");
        break;
      case "extension_ui_request":
        void this.answerDialog(event);
        break;
    }
  }

  /** At the limit, ask for a final answer; a turn later, if it still calls tools, stop with what it has. */
  private checkTurnLimit(stopReason: unknown) {
    const max = this.options.maxTurns;
    if (!max || stopReason !== "toolUse" || this.state.status !== "running") return;
    if (this.state.turns === max) {
      this.send({
        type: "steer",
        message: `You have used your ${max} turns. Do not call any more tools: reply now with your final answer, including what you found and what is left undone.`,
      });
    } else if (this.state.turns > max) {
      this.state.error = `stopped at the turn limit (${max}); the output may be partial`;
      this.stop();
    }
  }

  private finishAndClose(status: ChildStatus, error?: string) {
    this.finish(status, error);
    this.proc?.stdin?.end();
    const proc = this.proc;
    setTimeout(() => {
      if (proc && proc.exitCode === null) proc.kill("SIGTERM");
    }, 10_000).unref?.();
  }

  private async answerDialog(event: Record<string, any>) {
    const method = event.method;
    if (!["select", "confirm", "input", "editor"].includes(method)) return;
    let answer: DialogAnswer;
    if (!this.options.onDialog) this.state.error = `Headless worker requires user interaction: ${event.title ?? method}. Return this blocker to the parent; no permission was granted.`;
    try {
      answer = await this.options.onDialog?.({
        method,
        title: event.title,
        message: event.message,
        options: event.options,
        placeholder: event.placeholder,
        prefill: event.prefill,
      });
    } catch {
      answer = undefined;
    }
    this.send({ type: "extension_ui_response", id: event.id, ...(answer ?? { cancelled: true }) });
  }
}
