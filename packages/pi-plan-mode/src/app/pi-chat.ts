// A conversation as Pi itself shows it (a planner's or your main agent's in plan mode, Sidebar's, a subagent's):
// Pi's own message and tool components, fed by the session's events the way Pi's interactive mode
// feeds its chat: originating tool renderers where available, native built-ins next, then readable
// display-only fallbacks (remote worker events carry no renderer functions). Plan mode adds notes and labels
// for messages someone else sent (your main agent); Sidebar hides quiz blocks (`displayAssistant`).
// Copied verbatim into pi-plan-mode (src/app/pi-chat.ts), pi-sidebar (src/pi-chat.ts) and
// pi-subagents (src/ui/pi-chat.ts); change all three (scripts/test-contracts.mjs checks they stay
// identical).
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getMarkdownTheme,
  type Theme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  getCapabilities,
  Spacer,
  Text,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** What a tool call needs to render: its definition's renderCall/renderResult, if it has them. */
export type ToolRenderers = ConstructorParameters<typeof ToolExecutionComponent>[4];

export interface PiChatOptions {
  cwd: string;
  /** The originating session's definition; native tools and readable unknown-tool fallbacks follow. */
  toolDefinition?(name: string): ToolRenderers | undefined;
  /** Show user messages as their events arrive (your main session); planners label theirs instead. */
  userMessagesFromEvents?: boolean;
  requestRender?(): void;
  /** The assistant message as shown (Sidebar hides quiz mode's rubric and grade blocks). */
  displayAssistant?<T extends { role?: string; content?: unknown }>(message: T): T;
}

type Tone = "info" | "warning" | "error";
type Message = {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  timestamp?: number;
};
type ToolCall = { type: "toolCall"; id: string; name: string; arguments: unknown };

let sharedTheme: Theme | undefined;

/** The theme notes and labels use; the planning screen sets it when it opens. */
export function setPiChatTheme(theme: Theme) {
  sharedTheme = theme;
}

export const piChatTheme = () => sharedTheme;

/** Lines kept when a conversation grows past this many components (the oldest go). */
const MAX_COMPONENTS = 1_500;

export class PiChat {
  private readonly container = new Container();
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  private streaming: AssistantMessageComponent | undefined;
  private builtIns: Record<string, ToolRenderers> | undefined;
  private expanded = false;
  private hideThinking = false;
  /** Bumped on every change, so a renderer can tell when to re-render. */
  version = 0;

  constructor(
    private readonly theme: () => Theme | undefined,
    private readonly options: PiChatOptions,
  ) {}

  /** The transcript's components, top to bottom. */
  get children(): readonly Component[] {
    return this.container.children;
  }

  get empty() {
    return this.container.children.length === 0;
  }

  /** Expand tool output (like ctrl+o in pi), or collapse it again. */
  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    for (const child of this.container.children) {
      (child as { setExpanded?(value: boolean): void }).setExpanded?.(expanded);
    }
    this.changed();
  }

  get isExpanded() {
    return this.expanded;
  }

  /** Hide thinking blocks (like ctrl+t in pi), or show them again. */
  setThinkingHidden(hidden: boolean) {
    this.hideThinking = hidden;
    for (const child of this.container.children) {
      (child as { setHideThinkingBlock?(value: boolean): void }).setHideThinkingBlock?.(hidden);
    }
    this.changed();
  }

  get thinkingHidden() {
    return this.hideThinking;
  }

  /** Clicks on the transcript, such as a tool card's "click to show more", in document rows. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    try {
      return this.container.handleMouse(event);
    } catch {
      return undefined;
    }
  }

  render(width: number): string[] {
    try {
      return this.container.render(Math.max(1, width));
    } catch {
      return [];
    }
  }

  /** A line from plan mode itself: a plan submitted or delivered, a stop, a failure. */
  note(text: string, tone: Tone = "info") {
    const color = tone === "error" ? "error" : tone === "warning" ? "warning" : "muted";
    const theme = this.theme();
    this.add(new Text(theme ? theme.fg(color, `• ${text}`) : `• ${text}`, 1, 0));
  }

  /**
   * A message to the agent, labelled with who sent it when that was not you. `timestamp` is when it
   * was sent: pi-cc-render draws it as the prompt's clock (otherwise the time it was first drawn).
   */
  user(text: string, from?: string, timestamp?: number) {
    const theme = this.theme();
    if (!this.empty) this.add(new Spacer(1));
    if (from) this.add(new Text(theme ? theme.fg("warning", `${from} ›`) : `${from} ›`, 1, 0));
    const component = new UserMessageComponent(text, getMarkdownTheme());
    if (typeof timestamp === "number" && Number.isFinite(timestamp))
      (component as { timestamp?: number }).timestamp = timestamp;
    this.add(component);
  }

  /** Show earlier messages of the session (a restored planner, or your main session). */
  seed(
    messages: readonly unknown[],
    userText: (text: string, index: number) => { text: string; from?: string } | undefined,
  ) {
    const pending = new Map<string, ToolExecutionComponent>();
    let users = 0;
    for (const raw of messages) {
      const message = raw as Message;
      if (message.role === "user") {
        const shown = userText(contentText(message.content), users);
        users += 1;
        if (shown?.text.trim()) this.user(shown.text.trim(), shown.from, message.timestamp);
      } else if (message.role === "assistant") {
        this.add(this.assistant(message));
        for (const call of toolCalls(message)) {
          const component = this.tool(call);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            component.updateResult({
              content: [{ type: "text", text: message.errorMessage || "Error" }],
              isError: true,
            } as never);
          } else pending.set(call.id, component);
        }
      } else if (message.role === "toolResult" && message.toolCallId) {
        pending.get(message.toolCallId)?.updateResult(message as never);
        pending.delete(message.toolCallId);
      }
    }
    // Calls still waiting for a result (a session seeded mid-tool) get it from later events.
    for (const [id, component] of pending) this.pendingTools.set(id, component);
    this.changed();
  }

  /** One session event, handled as Pi's interactive mode handles it. */
  apply(event: Record<string, unknown>) {
    const message = (event.message ?? undefined) as Message | undefined;
    switch (event.type) {
      case "message_start":
        if (message?.role === "user" && this.options.userMessagesFromEvents) {
          const text = contentText(message.content).trim();
          if (text) this.user(text, undefined, message.timestamp);
        } else if (message?.role === "assistant") {
          this.streaming = this.assistant(undefined);
          this.add(this.streaming);
          this.streaming.updateContent(this.shown(message) as never, true);
        }
        break;
      case "message_update":
        if (this.streaming && message?.role === "assistant") {
          this.streaming.updateContent(this.shown(message) as never, true);
          for (const call of toolCalls(message)) {
            const existing = this.pendingTools.get(call.id);
            if (existing) existing.updateArgs(call.arguments);
            else this.pendingTools.set(call.id, this.tool(call));
          }
        }
        break;
      case "message_end":
        if (this.streaming && message?.role === "assistant") {
          this.streaming.updateContent(this.shown(message) as never, false);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            const text = message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error");
            for (const component of this.pendingTools.values()) {
              component.updateResult({ content: [{ type: "text", text }], isError: true } as never);
            }
            this.pendingTools.clear();
          } else {
            for (const component of this.pendingTools.values()) component.setArgsComplete();
          }
          this.streaming = undefined;
        }
        break;
      case "tool_execution_start": {
        if (event.parentToolCallId) break;
        const id = String(event.toolCallId ?? "");
        let component = this.pendingTools.get(id);
        if (!component) {
          component = this.tool({
            type: "toolCall",
            id,
            name: String(event.toolName ?? "tool"),
            arguments: event.args,
          });
          this.pendingTools.set(id, component);
        }
        component.markExecutionStarted();
        break;
      }
      case "tool_execution_update":
        this.pendingTools
          .get(String(event.toolCallId ?? ""))
          ?.updateResult({ ...(event.partialResult as object), isError: false } as never, true);
        break;
      case "tool_execution_end": {
        const id = String(event.toolCallId ?? "");
        this.pendingTools
          .get(id)
          ?.updateResult({ ...(event.result as object), isError: event.isError === true } as never);
        this.pendingTools.delete(id);
        break;
      }
      case "agent_end":
        if (this.streaming) {
          this.container.removeChild(this.streaming);
          this.streaming = undefined;
        }
        this.pendingTools.clear();
        break;
      case "auto_retry_start":
        this.note(
          `Retrying after: ${typeof event.errorMessage === "string" ? event.errorMessage : "provider error"}`,
          "warning",
        );
        return;
      case "compaction_start":
        this.note("Compacting context…");
        return;
      default:
        return;
    }
    this.changed();
  }

  private assistant(message: Message | undefined) {
    const component = new AssistantMessageComponent(
      (message ? this.shown(message) : message) as never,
      this.hideThinking,
      getMarkdownTheme(),
    );
    // pi-cc-render makes assistant messages expandable (Ctrl+O opens collapsed thinking): keep them
    // in step with this chat's own toggle instead of main's.
    (component as { setExpanded?(value: boolean): void }).setExpanded?.(this.expanded);
    return component;
  }

  private shown(message: Message): Message {
    return this.options.displayAssistant ? this.options.displayAssistant(message) : message;
  }

  private tool(call: ToolCall) {
    const ui = { requestRender: () => this.changed() } as never;
    const component = new ToolExecutionComponent(
      call.name,
      call.id,
      call.arguments,
      { showImages: true },
      this.renderers(call.name),
      ui,
      this.options.cwd,
    );
    component.setExpanded(this.expanded);
    this.add(component);
    return component;
  }

  /** Originating definitions win, then native tools, then display-only readable fallbacks. */
  private renderers(name: string): ToolRenderers {
    const definition = this.options.toolDefinition?.(name);
    this.builtIns ??= builtInRenderers(this.options.cwd);
    const builtIn = this.builtIns[name];
    const fallback = fallbackRenderers(name);
    return {
      ...builtIn,
      ...definition,
      renderCall: definition?.renderCall ?? builtIn?.renderCall ?? fallback.renderCall,
      renderResult: definition?.renderResult ?? builtIn?.renderResult ?? fallback.renderResult,
    };
  }

  private add(component: Component) {
    this.container.addChild(component);
    const children = this.container.children;
    if (children.length > MAX_COMPONENTS) children.splice(0, children.length - MAX_COMPONENTS);
    this.changed();
  }

  private changed() {
    this.version += 1;
    this.options.requestRender?.();
  }
}

function builtInRenderers(cwd: string): Record<string, ToolRenderers> {
  const renderers: Record<string, ToolRenderers> = {};
  for (const create of [
    createReadToolDefinition,
    createBashToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  ]) {
    try {
      const definition = create(cwd) as { name: string };
      renderers[definition.name] = definition as ToolRenderers;
    } catch {
      // A tool Pi cannot build here uses the display-only fallback.
    }
  }
  return renderers;
}

/** Only display-created values are formatted; literal result strings are never JSON-parsed. */
function fallbackRenderers(name: string): NonNullable<ToolRenderers> {
  return {
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold(label(name)));
      const fields = readableFields(args);
      const preview = fields
        .slice(0, 3)
        .map((line) => line.trim())
        .join(" · ");
      const body = context.expanded ? fields.join("\n") : shorten(preview, 180);
      const pending = context.isPartial ? (context.executionStarted ? "Working…" : "Pending…") : "";
      return new Text([title, body, pending && theme.fg("muted", pending)].filter(Boolean).join("\n"), 0, 0);
    },
    renderResult(result, options, theme, context) {
      const blocks = Array.isArray(result.content) ? result.content : [];
      const text = contentText(blocks);
      const lines = text.length > 0 ? text.split("\n") : readableFields(result.details);
      const images = blocks.filter((block) => block.type === "image");
      // ToolExecutionComponent owns native image rendering. Keep a visible placeholder otherwise.
      if (!context.showImages || !getCapabilities().images) {
        for (const image of images) lines.push(`[Image: ${clean(image.mimeType ?? "unknown format")}]`);
      }
      const status = context.isError ? "Error" : options.isPartial ? "Working…" : "Completed";
      if (!lines.length && !images.length) lines.push(options.isPartial ? "Waiting for output…" : "No output.");
      const visible = options.expanded ? lines : lines.slice(0, 8);
      const body = visible.map((line) => clean(line)).join("\n");
      const compact = shorten(body, 1_200);
      const more = !options.expanded && (visible.length < lines.length || compact !== body);
      return new Text(
        [
          theme.fg(context.isError ? "error" : "muted", status),
          options.expanded ? body : compact,
          ...(more ? ["… more output (expand to view)"] : []),
        ].join("\n"),
        0,
        0,
      );
    },
  };
}

function clean(text: string): string {
  // Preserve newlines and tabs but never execute control sequences supplied by a tool.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal display boundary
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function label(value: string): string {
  const text = clean(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Tool";
}

function shorten(text: string, limit: number): string {
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : text;
}

/** Bounded field/list traversal, without serializing multiline strings or changing its input. */
function readableFields(value: unknown): string[] {
  if (value === undefined) return [];
  const lines: string[] = [];
  const seen = new Set<object>();
  let remaining = 16_000;
  const push = (line: string) => {
    if (remaining <= 0 || lines.length >= 2_000) return;
    const shown = shorten(clean(line), remaining);
    lines.push(shown);
    remaining -= shown.length + 1;
  };
  const walk = (item: unknown, prefix: string, depth: number) => {
    if (remaining <= 0 || lines.length >= 2_000) return;
    if (item !== null && typeof item === "object") {
      if (seen.has(item)) return push(`${prefix}[Circular]`);
      if (depth >= 8) return push(`${prefix}… (nested details omitted)`);
      const entries = Array.isArray(item)
        ? item.map((entry, index) => [`${index + 1}.`, entry] as const)
        : Object.entries(item).map(([key, entry]) => [`${label(key)}:`, entry] as const);
      if (!entries.length) return push(`${prefix}${Array.isArray(item) ? "(empty list)" : "(empty object)"}`);
      seen.add(item);
      if (prefix.trim()) push(prefix.trimEnd());
      const indent = "  ".repeat(depth);
      for (const [key, entry] of entries) walk(entry, `${indent}${key} `, depth + 1);
      seen.delete(item);
    } else {
      const text = item === "" ? '""' : String(item);
      const parts = text.split("\n");
      if (parts.length === 1) push(`${prefix}${text}`);
      else {
        push(prefix.trimEnd());
        for (const part of parts) push(`${"  ".repeat(depth)}${part}`);
      }
    }
  };
  walk(value, "", 0);
  if (remaining <= 0 || lines.length >= 2_000) lines.push("… (display limit reached)");
  return lines;
}

function toolCalls(message: Message): ToolCall[] {
  return Array.isArray(message.content)
    ? (message.content as unknown[]).filter(
        (block): block is ToolCall => (block as { type?: unknown })?.type === "toolCall",
      )
    : [];
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? [String((block as { text?: unknown }).text ?? "")]
        : [],
    )
    .join("\n");
}
