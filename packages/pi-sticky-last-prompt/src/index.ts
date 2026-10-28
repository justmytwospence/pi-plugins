// Derived from pi-sticky-last-prompt 0.1.1 (MIT, pi-collections contributors).
// Exact artifact provenance and local changes: ../UPSTREAM.md.
import { randomUUID } from "node:crypto";
import {
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

interface ScrollViewLike {
  scrollTop: number;
  child?: unknown;
  getContentWidth?(width: number): number;
  scrollTo(scrollTop: number, options?: { disableFollow?: boolean }): void;
}

interface LayoutBoxLike {
  component?: unknown;
  rect?: { x: number; y: number; width: number; height: number };
  children?: readonly LayoutBoxLike[];
}

/** The screen rectangle of `component` in the last layout frame, if it was laid out. */
export function layoutRectOf(root: LayoutBoxLike | undefined | null, component: unknown): LayoutBoxLike["rect"] {
  const stack: LayoutBoxLike[] = root ? [root] : [];
  for (let guard = 0; stack.length > 0 && guard < 10_000; guard++) {
    const box = stack.pop()!;
    if (box.component === component) return box.rect;
    if (Array.isArray(box.children)) stack.push(...box.children);
  }
  return undefined;
}

/** The transcript scroll view under `root`: a valid scroll view whose child has children, primary first. */
export function findTranscriptView<T>(root: unknown, valid: (value: unknown) => value is T): T | undefined {
  const seen = new Set<unknown>();
  let fallback: T | undefined;
  const walk = (node: unknown, depth: number): T | undefined => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 8) return undefined;
    seen.add(node);
    const view = node as { primary?: unknown; child?: { children?: unknown } };
    if (valid(node) && Array.isArray(view.child?.children)) {
      if (view.primary === true) return node;
      fallback ??= node;
    }
    const parent = node as { children?: unknown; entries?: unknown };
    const kids = [
      ...(Array.isArray(parent.entries) ? parent.entries.map((entry) => (entry as { component?: unknown } | undefined)?.component) : []),
      ...(Array.isArray(parent.children) ? parent.children : []),
    ];
    for (const kid of kids) {
      const found = walk(kid, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(root, 0) ?? fallback;
}

interface OverlayEntryLike {
  component?: unknown;
  hidden?: boolean;
  options?: OverlayOptions;
}

/** These renderer internals are optional; missing members leave the bar blank. */
type AltScreen = TUI & {
  layoutRoot?: { entries?: readonly { component?: unknown }[] | null } | null;
  /** The last layout frame: boxes with each component's screen rectangle. */
  currentLayout?: { root?: LayoutBoxLike } | null;
  getPrimaryScrollView?: () => ScrollViewLike | undefined;
  overlayStack?: readonly unknown[];
  isOverlayVisible?: (entry: unknown) => boolean;
};

type HasOverlayWrapper = (() => boolean) & { [WRAPPER_TAG]?: string };

export const WIDGET_ID = "sticky-last-prompt";
export const WRAPPER_TAG = Symbol.for("pi-plugins.pi-sticky-last-prompt/has-overlay.v1");
export const OWNER = "pi-plugins/pi-sticky-last-prompt";
export const CLEAR_SENTINEL = "\u0000pi-clear-screen\u0000";
const PIN_ICON = "\uf007"; // Upstream pin glyph; requires a font with this private-use character.

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function renderLines(component: unknown, width: number): string[] {
  try {
    const render = (component as { render?: (w: number) => unknown }).render;
    const lines = typeof render === "function" ? render.call(component, width) : undefined;
    return Array.isArray(lines) && lines.every((line) => typeof line === "string") ? lines : [];
  } catch {
    return [];
  }
}

/** Match only pi-clear-screen's marker, not arbitrary lines containing NUL. */
export function isClearSentinel(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => line === CLEAR_SENTINEL);
}

/** Only plain Containers concatenate their children without padding or layout transforms. */
function isPlainContainer(value: unknown): value is { children: readonly unknown[] } {
  const name = (value as { constructor?: { name?: string } } | undefined)?.constructor?.name;
  return name === "Container" && Array.isArray((value as { children?: unknown }).children);
}

export interface UserAnchor {
  start: number;
  /** Exclusive end in document rows. */
  end: number;
  text: string;
  /** Live component identity: a click must not jump to an unseen replacement. */
  source?: unknown;
}

export interface ClearHorizon {
  row: number;
}

export interface AnchorIndex {
  anchors: UserAnchor[];
  horizons: ClearHorizon[];
}

export function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/** `tool`: a tool row carrying the user's words; renderers may group it with other calls. */
type Classifier = (child: unknown) => { kind: "user"; text: string; tool?: boolean } | { kind: "skill"; name: string } | undefined;

/**
 * The user's words in a tool group (pi-cc-render's ToolGroupComponent, say): a non-plain
 * component whose direct children include such tool rows. Its rows cannot be split by child,
 * so the whole group anchors with the latest words in it.
 */
function groupedWords(child: unknown, classify: Classifier): string | undefined {
  const children = (child as { children?: unknown } | undefined)?.children;
  if (!Array.isArray(children)) return undefined;
  let words: string | undefined;
  for (const kid of children) {
    const kind = classify(kid);
    if (kind?.kind === "user" && kind.tool) words = kind.text;
  }
  return words;
}

/**
 * User-words service (version 1): what the user told the agent through another plugin's dialog
 * (an ask_user_question answer, plan feedback, a message on a declined call) comes back as a
 * tool result, not a user message. Providers say how to read those words out of their results.
 * On each `session_start`, an active copy emits `{ version: 1, register }` on `USER_WORDS_CHANNEL`;
 * providers listening there call `register(toolName, extract)` before `emit` returns (`"*"`
 * matches any tool). Providers copy these declarations structurally; without this extension
 * nothing asks them.
 */
export const USER_WORDS_CHANNEL = "pi-plugins.user-words.v1";

export interface ToolCallView {
  toolName: string;
  args: unknown;
  result: { content?: unknown; details?: unknown; isError?: boolean };
}

/** The user's words in a finished call's result, or undefined when it carries none. */
export type UserWordsExtractor = (call: ToolCallView) => string | undefined;

export interface UserWordsRequest {
  version: 1;
  register?: (toolName: string, extract: UserWordsExtractor) => void;
}

export type UserWordsRegistry = ReadonlyMap<string, readonly UserWordsExtractor[]>;

function userWordsOf(child: unknown, registry: UserWordsRegistry): string | undefined {
  if (registry.size === 0 || !(child instanceof ToolExecutionComponent)) return undefined;
  // Renderer internals: the call's name, arguments and its final (not partial) result.
  const call = child as unknown as { toolName?: unknown; args?: unknown; result?: ToolCallView["result"]; isPartial?: unknown };
  if (typeof call.toolName !== "string" || !call.result || typeof call.result !== "object" || call.isPartial === true) return undefined;
  const view: ToolCallView = { toolName: call.toolName, args: call.args, result: call.result };
  for (const extract of [...(registry.get(call.toolName) ?? []), ...(registry.get("*") ?? [])]) {
    try {
      const words = extract(view);
      if (typeof words === "string" && words.trim()) return words;
    } catch {
      // A provider's bug must not blank the bar.
    }
  }
  return undefined;
}

/** Pi's prompt components, plus tool rows that carry the user's words per `registry`. */
export function makeClassifier(registry: UserWordsRegistry = new Map()): Classifier {
  return (child) => {
    if (child instanceof UserMessageComponent) {
      return { kind: "user", text: extractUserText((child as unknown as { text?: unknown }).text) };
    }
    if (child instanceof SkillInvocationMessageComponent) {
      const name = (child as unknown as { skillBlock?: { name?: unknown } }).skillBlock?.name;
      return { kind: "skill", name: typeof name === "string" ? name : "" };
    }
    const words = userWordsOf(child, registry);
    return words === undefined ? undefined : { kind: "user", text: words, tool: true };
  };
}

export const classifyPiComponent: Classifier = makeClassifier();

/** Walk live document rows, including nested transcript rebuilds and zero-row clears. */
export function collectAnchors(
  children: readonly unknown[],
  width: number,
  offset: number,
  index: AnchorIndex,
  classify: Classifier = classifyPiComponent,
): number {
  for (const child of children) {
    let kind = classify(child);
    if (!kind && !isPlainContainer(child)) {
      const words = groupedWords(child, classify);
      if (words !== undefined) kind = { kind: "user", text: words };
    }
    if (kind) {
      const height = renderLines(child, width).length;
      const text = kind.kind === "user" ? collapseWhitespace(kind.text) : collapseWhitespace(kind.name);
      if (text && height > 0) {
        index.anchors.push({ start: offset, end: offset + height, text: kind.kind === "skill" ? `[skill] ${text}` : text, source: child });
      }
      offset += height;
    } else if (isPlainContainer(child)) {
      offset = collectAnchors(child.children, width, offset, index, classify);
    } else {
      for (const line of renderLines(child, width)) {
        if (line === CLEAR_SENTINEL) index.horizons.push({ row: offset });
        else offset++;
      }
    }
  }
  return offset;
}

/**
 * A prompt on the top boundary or straddling it blanks the bar rather than pinning an older one.
 * Clear horizons do not hide earlier prompts: after Ctrl+L the latest prompt stays pinned.
 */
export function selectAnchor(index: AnchorIndex, scrollTop: number): UserAnchor | undefined {
  if (!Number.isFinite(scrollTop) || scrollTop < 0) return undefined;
  let selected: UserAnchor | undefined;
  for (const anchor of index.anchors) if (anchor.start <= scrollTop) selected = anchor;
  return selected && selected.end <= scrollTop ? selected : undefined;
}

/** The bar's one line: the pin glyph and the prompt on the selection background, `width` columns. */
export function renderPinBar(theme: Theme, text: string, width: number): string {
  // truncateToWidth ends a cut with a full reset (`ESC[0m`), which would also end the background:
  // cut the plain text ourselves, so the ellipsis keeps the text color, and reopen the background
  // after any reset that remains.
  const room = Math.max(0, width - 4);
  const label = visibleWidth(text) <= room ? text : `${truncateToWidth(text, Math.max(0, room - 1), "").replace(/\x1b\[0m$/, "")}…`;
  const line = truncateToWidth(` ${theme.fg("accent", PIN_ICON)} ${theme.fg("text", label)}`, width, "");
  const open = theme.bg("selectedBg", "\u0000").split("\u0000")[0] ?? "";
  return theme.bg("selectedBg", padToWidth(line, width).replaceAll("\x1b[0m", `\x1b[0m${open}`));
}

/**
 * Prompt-pin service (version 1) for other plugins' transcripts, such as pi-sidebar's. Discovery is
 * a synchronous request over `pi.events`: the consumer emits `{ version: 1 }` on `PIN_CHANNEL`; an
 * active copy sets `service` and `provider` before `emit` returns. Consumers copy these
 * declarations structurally; without this extension their transcripts pin nothing, as main does.
 */
export const PIN_CHANNEL = "pi-plugins.prompt-pin.v1";

export interface PinnedPrompt {
  /** First document row of the prompt. */
  start: number;
  /** Exclusive end row. */
  end: number;
  text: string;
}

export interface PromptPinService {
  /** The prompt to pin over a transcript of `children` rendered at `width` and scrolled to `top`. */
  anchor(children: readonly unknown[], width: number, top: number): PinnedPrompt | undefined;
  /** The bar for `text`, as main draws it. */
  bar(theme: Theme, text: string, width: number): string;
}

export interface PromptPinRequest {
  version: 1;
  service?: PromptPinService;
  provider?: string;
}

export function createPromptPinService(classify: Classifier = classifyPiComponent): PromptPinService {
  return {
    anchor(children, width, top) {
      const index: AnchorIndex = { anchors: [], horizons: [] };
      collectAnchors(children, Math.max(1, Math.floor(width)), 0, index, classify);
      const selected = selectAnchor(index, top);
      return selected ? { start: selected.start, end: selected.end, text: selected.text } : undefined;
    },
    bar: renderPinBar,
  };
}

export const promptPinService: PromptPinService = createPromptPinService();

const EMPTY_COMPONENT: Component = { render: () => [], invalidate: () => {} };

export class PinBar implements Component {
  renderedRows = 0;
  private getTheme: (() => Theme) | undefined;

  constructor(
    private readonly getText: () => string,
    private readonly onClick: () => void,
  ) {}

  setTheme(theme: Theme | (() => Theme)): void {
    this.getTheme = typeof theme === "function" ? theme : () => theme;
  }

  reset(): void {
    this.getTheme = undefined;
    this.renderedRows = 0;
  }

  render(width: number): string[] {
    width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const theme = this.getTheme?.();
    const text = this.getText();
    if (!theme || !text || width === 0) {
      this.renderedRows = 0;
      return [];
    }
    this.renderedRows = 1;
    return [renderPinBar(theme, text, width)];
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || this.renderedRows === 0 || event.y < 0 || event.y >= this.renderedRows || event.x < 0 || event.x >= event.width) return undefined;
    if (event.type === "press") return { handled: true, render: false };
    if (event.type === "click") {
      this.onClick();
      return { handled: true };
    }
    return undefined;
  }
}

/**
 * SDK 1.1 widget factories receive a stable Proxy, not the renderer instance. Its get trap
 * wraps every method (losing function identity/tags), and it has no ownKeys/delete trap.
 * A temporary symbol method lets that get trap supply the real receiver as `this`. Remove
 * the probe from that receiver immediately, then do all ownership checks/cleanup on it.
 */
function rendererOf(reference: TUI): AltScreen | undefined {
  const key = Symbol("sticky-last-prompt/renderer-probe");
  const probe = function (this: AltScreen): AltScreen { return this; };
  let screen: AltScreen | undefined;
  try {
    if (!Reflect.set(reference, key, probe)) return undefined;
    screen = Reflect.apply(Reflect.get(reference, key), reference, []) as AltScreen;
    return screen;
  } catch {
    return undefined;
  } finally {
    if (screen && Reflect.get(screen, key) === probe) Reflect.deleteProperty(screen, key);
  }
}

export default function stickyLastPrompt(pi: ExtensionAPI): void {
  // Per-instance keys keep late shutdown/disposal from removing a newer copy's widget.
  const widgetId = `${WIDGET_ID}/${randomUUID()}`;
  let screen: AltScreen | undefined;
  let overlay: OverlayHandle | undefined;
  let generation = 0;
  let removeWidget: (() => void) | undefined;
  let notify: ((message: string) => void) | undefined;
  let warnedDuplicate = false;
  let releasePatch: (() => void) | undefined;
  let paintedAnchor: UserAnchor | undefined;
  let serving = false;
  const userWords = new Map<string, UserWordsExtractor[]>();
  const classify = makeClassifier(userWords);
  const pinService = createPromptPinService(classify);
  // Pi keeps this object and reads it on every render, so a narrower transcript moves the bar.
  const barOptions: OverlayOptions = { anchor: "top-left", row: 0, col: 0, width: "100%", nonCapturing: true };

  const bar = new PinBar(
    () => {
      paintedAnchor = currentSelection();
      return paintedAnchor?.text ?? "";
    },
    () => {
      const selected = currentSelection();
      const sv = primaryScrollView();
      if (!selected || !sv || !paintedAnchor || selected.source !== paintedAnchor.source || selected.text !== paintedAnchor.text) return;
      sv.scrollTo(Math.max(0, selected.start - bar.renderedRows), { disableFollow: true });
      screen?.requestRender();
    },
  );

  function primaryScrollView(): ScrollViewLike | undefined {
    if (!screen) return undefined;
    const valid = (value: unknown): value is ScrollViewLike => {
      const sv = value as Partial<ScrollViewLike> | undefined;
      return !!sv && Number.isFinite(sv.scrollTop) && typeof sv.scrollTo === "function";
    };
    try {
      const direct = screen.getPrimaryScrollView?.();
      // Before the first layout, Pi returns an implicit scroll view without transcript children.
      if (valid(direct) && Array.isArray((direct.child as { children?: unknown } | undefined)?.children)) return direct;
    } catch {
      // Fall back to the mounted primary scroll view.
    }
    // Another scroll view can be primary (pi-sidebar's panel while it has focus): find main's
    // transcript, the scroll view over a document with children, anywhere in the layout tree.
    return findTranscriptView(screen.layoutRoot, valid);
  }

  function isVisible(entry: OverlayEntryLike): boolean {
    if (!screen) return false;
    try {
      return typeof screen.isOverlayVisible === "function" ? screen.isOverlayVisible(entry) : !entry.hidden;
    } catch {
      return true; // Conservative: retain stock suppression when visibility is uncertain.
    }
  }

  function duplicateBarVisible(): boolean {
    if (!Array.isArray(screen?.overlayStack)) return false;
    for (const raw of screen.overlayStack) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as OverlayEntryLike;
      if (entry.component === bar || !isVisible(entry)) continue;
      const options = entry.options;
      if (options?.anchor === "top-left" && options.row === 0 && options.col === 0 && options.width === "100%" && options.nonCapturing) {
        if (!warnedDuplicate) {
          warnedDuplicate = true;
          notify?.("sticky-last-prompt: another top prompt bar is shown; this copy stays hidden. Enable only one copy.");
        }
        return true;
      }
    }
    return false;
  }

  function currentSelection(): UserAnchor | undefined {
    if (screen?.mode !== "fullscreen" || duplicateBarVisible()) return undefined;
    const sv = primaryScrollView();
    const children = (sv?.child as { children?: unknown } | undefined)?.children;
    if (!sv || !Array.isArray(children)) return undefined;
    try {
      const termWidth = screen.terminal.columns;
      // The transcript may not span the screen (pi-sidebar puts a panel beside it): the bar covers
      // only the transcript, and anchors are measured at its width.
      const rect = layoutRectOf(screen.currentLayout?.root, sv);
      const boxWidth = rect && rect.width > 0 ? rect.width : termWidth;
      if (rect && rect.width > 0 && rect.width < termWidth) Object.assign(barOptions, { row: rect.y, col: rect.x, width: rect.width });
      else Object.assign(barOptions, { row: 0, col: 0, width: "100%" });
      const width = sv.getContentWidth?.(boxWidth) ?? boxWidth;
      if (!Number.isFinite(width) || width < 1) return undefined;
      // Outer children identity + total height cannot detect nested, in-place, same-height
      // edits or skill expansion. Rewalk on each paint; component render caches still apply.
      const index: AnchorIndex = { anchors: [], horizons: [] };
      collectAnchors(children, Math.floor(width), 0, index, classify);
      return selectAnchor(index, sv.scrollTop);
    } catch {
      return undefined;
    }
  }

  function installPatch(target: AltScreen): boolean {
    const original = target.hasOverlay;
    if (typeof original !== "function") return false;
    // Legacy npm teardown deletes through the SDK Proxy, leaving an untagged own
    // method on the renderer. Chain it (or any unknown wrapper), never discard it.
    // Tagged owners yield no safe evidence of abandonment; released wrappers clear
    // their tag below. Untagged live legacy copies are caught by duplicateBarVisible.
    if ((original as HasOverlayWrapper)[WRAPPER_TAG] === OWNER) {
      notify?.("sticky-last-prompt: another copy already wraps the renderer's hasOverlay(); this copy stays inactive. Enable only one copy.");
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(target, "hasOverlay");
    let enabled = true;
    const wrapper: HasOverlayWrapper = () => {
      if (!enabled || !Array.isArray(target.overlayStack)) return original.call(target);
      for (const raw of target.overlayStack) {
        if (!raw || typeof raw !== "object") return original.call(target);
        const entry = raw as OverlayEntryLike;
        if (isVisible(entry) && entry.component !== bar) return original.call(target);
      }
      return false;
    };
    wrapper[WRAPPER_TAG] = OWNER;
    try {
      Object.defineProperty(target, "hasOverlay", {
        value: wrapper, writable: true, configurable: true, enumerable: descriptor?.enumerable ?? false,
      });
    } catch {
      return false;
    }
    releasePatch = () => {
      enabled = false;
      delete wrapper[WRAPPER_TAG];
      // A later wrapper may call ours: disable our behavior, but leave their method intact.
      // Compare the own data slot, not a getter's result, before restoring exactly what
      // we replaced (including accessors/flags), or exposing the inherited method again.
      if (Object.getOwnPropertyDescriptor(target, "hasOverlay")?.value === wrapper) {
        if (descriptor) Object.defineProperty(target, "hasOverlay", descriptor);
        else Reflect.deleteProperty(target, "hasOverlay");
      }
    };
    return true;
  }

  function teardown(): void {
    generation++;
    const overlayHandle = overlay;
    const cleanup = [releasePatch, overlayHandle ? () => overlayHandle.hide() : undefined, removeWidget];
    removeWidget = undefined;
    releasePatch = undefined;
    overlay = undefined;
    screen = undefined;
    notify = undefined;
    bar.reset();
    paintedAnchor = undefined;
    warnedDuplicate = false;
    serving = false;
    userWords.clear();
    for (const release of cleanup) {
      try {
        release?.();
      } catch {
        // A dead terminal/UI must not prevent the remaining independent cleanup steps.
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    teardown();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    const mine = generation;
    serving = true;
    const request: UserWordsRequest = {
      version: 1,
      register: (toolName, extract) => {
        if (mine !== generation || typeof toolName !== "string" || typeof extract !== "function") return;
        const list = userWords.get(toolName) ?? [];
        if (!list.includes(extract)) list.push(extract);
        userWords.set(toolName, list);
      },
    };
    try {
      pi.events?.emit?.(USER_WORDS_CHANNEL, request);
    } catch {
      // A provider that throws only loses its own words.
    }
    notify = (message) => ctx.ui.notify(message, "warning");
    removeWidget = () => ctx.ui.setWidget(widgetId, undefined);
    try {
      ctx.ui.setWidget(widgetId, (tui) => {
        if (mine !== generation || tui.mode !== "fullscreen") return EMPTY_COMPONENT;
        screen = rendererOf(tui);
        if (!screen || !installPatch(screen)) return EMPTY_COMPONENT;
        bar.setTheme(() => ctx.ui.theme);
        overlay = screen.showOverlay(bar, barOptions);
        return { ...EMPTY_COMPONENT, dispose: () => { if (mine === generation) teardown(); } };
      });
    } catch (error) {
      teardown();
      throw error;
    }
  });

  pi.on("session_shutdown", () => teardown());

  pi.events?.on?.(PIN_CHANNEL, (data: unknown) => {
    const request = data as PromptPinRequest | undefined;
    if (!serving || !request || request.version !== 1 || request.service) return;
    request.service = pinService;
    request.provider = "pi-sticky-last-prompt";
  });
}
