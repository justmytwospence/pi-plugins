// pi-next-prompt: after a run, suggests the prompt you would most likely send next, the way Claude
// Code does: dim ghost text inside the empty editor, Tab (or Right) fills it in, typing hides it
// and clearing the editor again brings it back. The main model writes the suggestion itself, in a last `<next>…</next>` line it
// adds only when one next step is obvious (a short standing prompt section asks for it). The line
// is stripped before the message is stored, so it never reaches the transcript or later context;
// Jev vets it before it is shown and fails open.
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type KeyId, type TUI, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { type ClassifierQuestion, type JevConfig, askJev, bool } from "./jev.ts";
import { INSTRUCTION, INTERACTIVE_INSTRUCTION, extractNext } from "./tag.ts";
import { clip, clipTail, messageText } from "./transcript.ts";

export interface NextPromptConfig extends Record<string, unknown> {
  enabled: boolean;
  acceptKeys: string[];
  maxChars: number;
  jev: JevConfig & { threshold: number };
}

export const DEFAULT_CONFIG: NextPromptConfig = {
  enabled: true,
  acceptKeys: ["tab", "right"],
  maxChars: 0,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 1_500, threshold: 0.6 },
};

export const SECTION = "next_prompt";
const WIDGET_KEY = "next-prompt";
const PROBE_KEY = "next-prompt-probe";
/** The editor's software cursor on an empty line: a reverse-video space. */
const EMPTY_CURSOR = "\x1b[7m \x1b[0m";
/** Where the hardware cursor goes; editors that use it (pi-vim) drop the software cursor. */
const CURSOR_MARKER = "\x1b_pi:c\x07";

const hasCursor = (line: string) => line.includes(EMPTY_CURSOR) || line.includes(CURSOR_MARKER);

/**
 * Put `text` as ghost text where the editor draws its cursor on an empty line: the cursor sits on
 * the first character, the rest is dim, with no hint (Tab or Right accepts). Returns undefined when the line has no cursor.
 */
export function ghostLine(line: string, text: string, width: number, dim: (s: string) => string) {
  if (text === "") return undefined;
  let body: string;
  const soft = line.indexOf(EMPTY_CURSOR);
  if (soft !== -1) {
    const [first, ...rest] = [...text];
    body = `${line.slice(0, soft)}\x1b[7m${first}\x1b[0m${dim(rest.join(""))}`;
  } else {
    const hard = line.indexOf(CURSOR_MARKER);
    if (hard === -1) return undefined;
    // The terminal's own cursor lands on the first character.
    body = `${line.slice(0, hard + CURSOR_MARKER.length)}${dim(text)}`;
  }
  const rightPad = /^ */.exec(line)![0].length;
  const clipped = truncateToWidth(body, Math.max(1, width - rightPad));
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

const SURFACE = Symbol.for("pi-plugins.editor-surface.v1");
const MODE = Symbol.for("pi-plugins.editor-mode.v1");
type Renderable = { render(width: number): string[]; getText(): string; isShowingAutocomplete?(): boolean; [SURFACE]?: string; [MODE]?: () => { state: string; autocomplete?: boolean } };

export const QUESTIONS: Record<string, ClassifierQuestion> = {
  useful: {
    type: "bool",
    instructions:
      "A coding agent finished answering `last_user_prompt` with a response ending in `assistant_text_tail`, and proposes `suggestion` as the user's next message. " +
      "Is the suggestion a concrete, non-generic next step that follows from the response, is not already done, and the user would plausibly send next?",
    criteria: {
      true: "A specific, useful next step the user would likely send",
      false: "Generic, already done, unrelated, or a guess among several options",
    },
  },
};

export interface Pending {
  suggestion: string;
  userPrompt: string;
  assistantTail: string;
}

export interface Verdict {
  show: boolean;
  reason: string;
}

/** What the vet tells Jev about a suggestion: the prompt and the response's tail, clipped, and the suggestion. */
export function vetState(pending: Pending): Record<string, unknown> {
  return {
    last_user_prompt: clip(pending.userPrompt, 1_500),
    assistant_text_tail: clipTail(pending.assistantTail, 2_000),
    suggestion: pending.suggestion,
  };
}

/** Jev's vote on a suggestion. Shown when Jev is off or unavailable: the model already abstains on its own. */
export async function vet(registry: unknown, config: NextPromptConfig["jev"], pending: Pending): Promise<Verdict> {
  if (!config.enabled) return { show: true, reason: "judge off" };
  const outcome = await askJev(registry, config, vetState(pending), QUESTIONS);
  if (!outcome.ok) return { show: true, reason: `judge unavailable (${outcome.reason}), shown anyway` };
  const p = bool(outcome.answers, "useful");
  if (p === undefined) return { show: true, reason: "judge gave no answer, shown anyway" };
  return { show: p >= config.threshold, reason: `judge ${p.toFixed(2)} ${p >= config.threshold ? ">=" : "<"} ${config.threshold}` };
}

type Block = { type?: string; text?: string };

/** Strip the tag lines from an assistant message. Returns the replacement (if changed) and the suggestion. */
export function processAssistant(message: { role?: string; content?: unknown }, maxChars: number) {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return { suggestion: undefined, replacement: undefined };
  let suggestion: string | undefined;
  let changed = false;
  const content = (message.content as Block[]).map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const out = extractNext(block.text, maxChars);
    if (!out.found) return block;
    changed = true;
    suggestion = out.suggestion;
    return { ...block, text: out.text };
  });
  return { suggestion, replacement: changed ? { ...message, content } : undefined };
}

export default function nextPrompt(pi: ExtensionAPI) {
  let config: NextPromptConfig = DEFAULT_CONFIG;
  let sessionOn = true;
  let ui: ExtensionUIContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let userPrompt = "";
  let pending: Pending | undefined;
  let outcome: string | undefined;
  let settled = false;
  /** The suggestion on offer until the next prompt is sent; `shown` is set while it is on screen. */
  let offered: string | undefined;
  let shown: string | undefined;
  // Which extension offered the current suggestion through `prompt:offer` (undefined: the model's own).
  let offerSource: string | undefined;
  // A turn is running: offers from other extensions wait for the user's next idle moment.
  let busy = false;
  let generation = 0;
  type Surface = "ghost" | "widget";
  type OfferDetails = { status: "displayed" | "blocked"; text?: string; reason?: string; surface?: Surface; acceptAfterTurn?: boolean };
  type ExplicitOffer = { id: number; text: string; surface?: Surface; acknowledged: boolean; finish?: (details: OfferDetails) => void };
  let explicit: ExplicitOffer | undefined;
  let lastExplicit = "none yet";
  const blocked = (reason: string): OfferDetails => ({ status: "blocked", reason });
  const displayed = (offer: ExplicitOffer): OfferDetails => ({ status: "displayed", text: offer.text, surface: offer.surface, acceptAfterTurn: busy });
  let lastVerdict = "";
  let lastTag = "none yet";
  let instruction = "not evaluated yet";
  let uiState = "not attached";
  let vetState = "not run";
  let mainEditor: Renderable | undefined;
  let terminal: TUI | undefined;
  let patched: { editor: Renderable; render: Renderable["render"]; wrapper: Renderable["render"]; own: boolean; tui: TUI; enabled: boolean } | undefined;

  const focusedEditor = () => (terminal as (TUI & { getFocusedComponent?(): unknown }) | undefined)?.getFocusedComponent?.() as Renderable | undefined;
  const focusState = () => {
    const focused = focusedEditor();
    if (!focused) return "unavailable";
    if (focused[SURFACE] === "embedded") return "embedded editor";
    if (focused !== mainEditor && focused[SURFACE] !== "main") return "not main editor";
    if (focused.isShowingAutocomplete?.()) return "autocomplete";
    const mode = focused[MODE]?.();
    if (mode?.autocomplete) return "autocomplete";
    if (mode && !["normal", "insert"].includes(mode.state)) return `editor mode ${mode.state}`;
    return "main editor";
  };
  const mainFocused = (): Renderable | undefined => focusState() === "main editor" ? focusedEditor() : undefined;

  const active = () => sessionOn && config.enabled;

  const unpatch = () => {
    if (!patched) return;
    const patch = patched;
    const { editor, render, wrapper, own, tui } = patch;
    patch.enabled = false;
    patched = undefined;
    if (editor.render === wrapper) {
      if (own) editor.render = render;
      else delete (editor as Partial<Renderable>).render;
    }
    tui.requestRender();
  };

  /** Take the suggestion off screen but keep it on offer, for when the editor is empty again. */
  const conceal = () => {
    if (shown === undefined) return;
    shown = undefined;
    unpatch();
    ui?.setWidget(WIDGET_KEY, undefined);
  };

  const hide = (reason = "offer cleared") => {
    const previous = explicit;
    explicit = undefined;
    if (previous) {
      lastExplicit = reason;
      previous.finish?.(blocked(reason));
    }
    offered = undefined;
    offerSource = undefined;
    conceal();
  };

  /** Pi hands widget factories the TUI; a throwaway widget is the only way to reach it. */
  const grabTui = (target: ExtensionUIContext) => {
    let tui: TUI | undefined;
    target.setWidget(PROBE_KEY, (t) => {
      tui = t;
      return { render: () => [], invalidate: () => {} };
    }, { placement: "belowEditor" });
    target.setWidget(PROBE_KEY, undefined);
    return tui as TUI | undefined;
  };

  /** Draw the suggestion inside the focused editor by wrapping its render. False if that is not possible. */
  const ghost = (target: ExtensionUIContext, observed?: (surface: Surface) => void) => {
    terminal = grabTui(target) ?? terminal;
    const tui = terminal;
    const editor = mainFocused();
    if (!tui || !editor || typeof editor.render !== "function" || typeof editor.getText !== "function") return false;
    if (editor.getText() !== "") return false;
    const render = editor.render;
    const width = tui.terminal?.columns ?? 80;
    // An editor that draws no cursor at all gets the line below instead.
    if (!render.call(editor, width).some(hasCursor)) return false;
    const own = Object.prototype.hasOwnProperty.call(editor, "render");
    const patch = { editor, render, wrapper: render, own, tui, enabled: true };
    const owner = explicit;
    const wrapper = function (this: Renderable, w: number) {
      const lines = render.call(this, w);
      if (!patch.enabled) return lines;
      if (!mainFocused() || this.getText() !== "") {
        if (owner) queueMicrotask(() => { if (explicit === owner) hide("editor draft or focus changed"); });
        return lines;
      }
      if (shown === undefined) return lines;
      const i = lines.findIndex(hasCursor);
      const line = i === -1 ? undefined : ghostLine(lines[i]!, shown, w, (s) => target.theme.fg("dim", s));
      if (line === undefined) return lines;
      const out = lines.slice();
      out[i] = line;
      observed?.("ghost");
      return out;
    };
    editor.render = wrapper;
    patch.wrapper = wrapper;
    patched = patch;
    tui.requestRender();
    return true;
  };

  const reset = () => {
    generation++;
    pending = undefined;
    outcome = undefined;
    settled = false;
    lastTag = "none yet";
    lastVerdict = "";
    vetState = "not run";
    hide();
  };

  const show = (text: string, observed?: (surface: Surface) => void) => {
    if (!ui) return;
    unpatch();
    ui.setWidget(WIDGET_KEY, undefined);
    const owner = explicit;
    offered = text;
    shown = text;
    const hint = `${keyLabel(config.acceptKeys[0] ?? "tab")} to accept`;
    if (ghost(ui, observed)) return;
    ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => ({
        render: (width: number) => {
          if (observed && (!active() || !mainFocused() || ui?.getEditorText() !== "" || shown !== text)) {
            if (owner) queueMicrotask(() => { if (explicit === owner) hide("editor draft or focus changed"); });
            return [];
          }
          const line = truncateToWidth(`${theme.fg("dim", `→ ${text}`)}  ${theme.fg("muted", hint)}`, width);
          if (line.length > 0) observed?.("widget");
          return [line];
        },
        invalidate: () => {},
      }),
      { placement: "belowEditor" },
    );
  };

  pi.registerTool({
    name: "offer_terminal",
    label: "Offer terminal command",
    exposure: "model-only",
    description: "Displays an editable !i suggestion, never executes it. Waits at most one second for a render acknowledgement; returns an explicit blocked reason if it cannot be displayed.",
    promptGuidelines: [
      "Use offer_terminal for interactive shell handoffs with the complete raw shell command (no !i prefix).",
      "Never claim a command was offered unless offer_terminal returned status displayed. After a displayed result explain Tab/Right then Enter, available after the response finishes.",
    ],
    parameters: Type.Object({ command: Type.String({ minLength: 1 }) }),
    async execute(_id, { command }, signal, _update, ctx) {
      const result = (details: OfferDetails) => {
        lastExplicit = details.status === "displayed" ? `displayed (${details.surface})` : details.reason!;
        return {
          content: [{ type: "text" as const, text: details.status === "displayed"
            ? `Displayed editable suggestion: ${details.text}\nAfter the current response finishes, press Tab/Right to copy it, then Enter to run it. Nothing was executed.`
            : `Terminal suggestion blocked: ${details.reason}` }],
          details,
          ...(details.status === "blocked" ? { isError: true } : {}),
        };
      };
      if (!command.trim()) return result(blocked("command is empty"));
      if (command !== command.trim()) return result(blocked("leading or trailing whitespace cannot be preserved by Pi's shell submission; command was not offered"));
      if (/[\x00-\x1f\x7f-\x9f]/u.test(command)) return result(blocked("command contains control characters or line breaks"));
      if (/^!!?i(?:\s|$)/u.test(command.trimStart())) return result(blocked("provide the raw command without !i or !!i prefix"));
      const text = `!i ${command}`;
      if (config.maxChars > 0 && text.length > config.maxChars) return result(blocked("command exceeds maxChars; shell commands are never truncated"));
      if (!active()) return result(blocked("next-prompt is disabled"));
      if (ctx.mode !== "tui" || !ctx.hasUI || !ui || !terminal) return result(blocked(`terminal UI is not attached (${uiState})`));
      if (ui.getEditorText() !== "") {
        if (explicit) hide("editor contains a draft");
        return result(blocked("editor contains a draft"));
      }
      if (!mainFocused()) {
        if (explicit) hide("main editor lost focus");
        return result(blocked(`main editor is not focused (${focusState()})`));
      }
      if (signal?.aborted) return result(blocked("tool aborted"));
      let shell: { available?: boolean; layout?: string; source?: string; reason?: string; shape?: unknown; rendererMode?: string } | undefined;
      pi.events.emit("interactive-shell:inspect", { reply: (info: typeof shell) => { shell = info; } });
      if (!shell) return result(blocked("interactive-shell support is missing"));
      if (!shell.available || shell.layout !== "inline") return result(blocked(`interactive-shell unavailable: ${JSON.stringify(shell)}`));
      if (offerSource !== undefined) return result(blocked("another extension owns the current offer"));
      if (explicit) {
        if (explicit.text !== text) return result(blocked("a different explicit offer is outstanding"));
        if (explicit.acknowledged && shown === text) return result(displayed(explicit));
        return result(blocked("identical explicit offer is still awaiting render acknowledgement"));
      }
      const offer: ExplicitOffer = { id: ++generation, text, acknowledged: false };
      explicit = offer;
      const details = await new Promise<OfferDetails>((resolve) => {
        let finished = false;
        const finish = (value: OfferDetails) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          offer.finish = undefined;
          resolve(value);
        };
        const fail = (reason: string) => {
          if (explicit === offer) hide(reason);
          else finish(blocked(reason));
        };
        const abort = () => fail("tool aborted");
        const timer = setTimeout(() => fail("no render acknowledgement within one second"), 1_000);
        offer.finish = finish;
        signal?.addEventListener("abort", abort, { once: true });
        show(text, (surface) => {
          queueMicrotask(() => {
            if (finished) return;
            if (explicit !== offer || generation !== offer.id || !active() || !mainFocused() || ui?.getEditorText() !== "" || shown !== text) {
              fail("offer invalidated before render acknowledgement");
              return;
            }
            offer.surface = surface;
            offer.acknowledged = true;
            finish(displayed(offer));
          });
        });
      });
      return result(details);
    },
  });

  const onKey = (data: string) => {
    if (explicit && (!mainFocused() || ui?.getEditorText() !== "")) hide("editor draft or focus changed");
    if (offered === undefined || !ui || isKeyRelease(data) || !mainFocused()) return undefined;
    if (matchesKey(data, "tab")) {
      const navigation = { handled: false, phase: "active" };
      pi.events.emit("activity:prompt-tab", navigation);
      if (navigation.handled) return { consume: true };
    }
    const accept = config.acceptKeys.some((key) => matchesKey(data, key as KeyId));
    if (accept && explicit && (busy || !explicit.acknowledged)) return undefined;
    if (accept && shown !== undefined && ui.getEditorText() === "") {
      const text = shown;
      const modelSuggestion = offerSource === undefined;
      hide();
      ui.setEditorText(text);
      if (modelSuggestion && text.startsWith("!i ")) pi.events.emit("interactive-shell:suggestion-accepted", { text });
      // The owned editor offers an optional local insertion hook; no submission occurs.
      const editor = mainFocused() as (Renderable & { [key: symbol]: unknown }) | undefined;
      const insert = editor?.[Symbol.for("pi-plugins.editor-insert.v1")];
      if (typeof insert === "function") insert.call(editor);
      return { consume: true };
    }
    // Once the key has reached the editor: hide while it holds text, show again once it is empty.
    const mine = generation;
    setTimeout(() => {
      if (mine !== generation || offered === undefined || !ui || !mainFocused()) return;
      const empty = ui.getEditorText() === "";
      if (!empty && explicit) hide("editor draft entered");
      else if (!empty) conceal();
      else if (shown === undefined) show(offered);
    }, 0);
    return undefined;
  };

  // Synchronous optional integration: select-nav can accept the offer before
  // handing Tab to task panels, independent of terminal-listener load order.
  pi.events.on("prompt:accept-next", (data) => {
    const request = data as { handled?: boolean } | undefined;
    if (request && !request.handled) request.handled = onKey("\t")?.consume === true;
  });

  // Optional pi-stash integration: Ctrl+S on an empty main editor with nothing stashed
  // takes the suggestion on screen into the stash, as if it were the draft.
  pi.events.on("prompt:take-next", (data) => {
    const request = data as { text?: string } | undefined;
    if (!request || request.text !== undefined || shown === undefined || !ui) return;
    if (ui.getEditorText() !== "" || !mainFocused() || (explicit && (busy || !explicit.acknowledged))) return;
    request.text = shown;
    hide();
  });

  const attach = (ctx: ExtensionContext) => {
    unsubscribe?.();
    unsubscribe = undefined;
    uiState = ctx.mode !== "tui" ? `not terminal UI (${ctx.mode})` : !ctx.hasUI ? "no UI" : "terminal UI";
    ui = ctx.mode === "tui" && ctx.hasUI ? ctx.ui : undefined;
    terminal = ui ? grabTui(ui) : undefined;
    if (ui && typeof (terminal as (TUI & { getFocusedComponent?(): unknown }) | undefined)?.getFocusedComponent !== "function") {
      uiState = "focus inspection unavailable";
      ui.notify("next-prompt: focus inspection unavailable; suggestions disabled for this UI", "warning");
      ui = undefined;
      terminal = undefined;
    }
    const focused = (terminal as (TUI & { getFocusedComponent?(): unknown }) | undefined)?.getFocusedComponent?.() as Renderable | undefined;
    mainEditor = focused && typeof focused.getText === "function" && focused[SURFACE] !== "embedded" ? focused : undefined;
    if (ui) unsubscribe = ui.onTerminalInput(onKey);
  };

  pi.on("session_start", (_event, ctx) => {
    config = loadConfig("next-prompt", DEFAULT_CONFIG, ctx.cwd);
    busy = false;
    reset();
    attach(ctx);
  });

  pi.on("session_shutdown", () => {
    reset();
    unsubscribe?.();
    unsubscribe = undefined;
    ui = undefined;
    uiState = "session shut down";
    mainEditor = undefined;
    terminal = undefined;
  });

  pi.on("session_tree", () => reset());
  pi.on("model_select", () => reset());
  pi.on("session_compact", () => reset());
  pi.on("input", () => {
    reset();
    return undefined;
  });
  // Bang submissions bypass the ordinary input event. Never leave an old offer behind.
  pi.on("user_bash", () => { reset(); return undefined; });
  // A user_bash interceptor may stop propagation before our handler (any load order).
  pi.events.on("prompt:clear", reset);

  pi.on("before_agent_start", (event, ctx) => {
    config = loadConfig("next-prompt", DEFAULT_CONFIG, ctx.cwd);
    if ("prompt" in event) userPrompt = event.prompt;
    // Only interactive sessions get the instruction: print mode and subagents have nowhere to show it.
    instruction = !active() ? "not injected (disabled)" : ctx.mode !== "tui" || !ctx.hasUI || !ui ? `not injected (${uiState})` : "injected";
    if (instruction !== "injected") return undefined;
    let interactive = false;
    pi.events.emit("interactive-shell:probe", { reply: () => { interactive = true; } });
    event.systemPromptOptions.sections[SECTION] = INSTRUCTION + (interactive ? INTERACTIVE_INSTRUCTION : "");
    return undefined;
  });

  pi.on("agent_start", () => {
    busy = true;
    reset();
  });

  // Optional bus integration: another extension offers a next prompt while Pi is idle
  // (pi-marimo when a Lens selection appears), or withdraws its own offer (text undefined).
  // The model's own suggestion is never replaced, and nothing is ever sent.
  pi.events.on("prompt:offer", (data) => {
    const request = data as { source?: unknown; text?: unknown } | undefined;
    const source = typeof request?.source === "string" ? request.source : undefined;
    if (!source) return;
    const text = typeof request?.text === "string" ? request.text.replace(/\s+/g, " ").trim().slice(0, config.maxChars > 0 ? config.maxChars : undefined) : "";
    if (!text) {
      if (offerSource === source) hide();
      return;
    }
    if (!active() || !ui || busy) return;
    if (offered !== undefined && offerSource === undefined) return;
    generation++;
    if (ui.getEditorText() === "") show(text);
    else { conceal(); offered = text; }
    offerSource = source;
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant") return undefined;
    const { suggestion, replacement } = processAssistant(message, config.maxChars);
    lastTag = suggestion ? "valid tag" : replacement ? "invalid tag (empty or over maxChars)" : "no tag emitted (model omission/abstention)";
    // The latest assistant message decides: a tag before a tool call is superseded by the final answer.
    pending = suggestion
      ? { suggestion, userPrompt, assistantTail: messageText((replacement ?? message).content) }
      : undefined;
    return replacement ? { message: replacement as typeof event.message } : undefined;
  });

  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome;
    return undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    settled = true;
    busy = false;
    const candidate = pending;
    pending = undefined;
    if (explicit) {
      if (outcome !== "completed") hide(`turn ${outcome ?? "not completed"}`);
      else if (!active() || !ui || !mainFocused() || ui.getEditorText() !== "") hide("editor draft or focus changed");
      return;
    }
    if (!candidate || outcome !== "completed" || !active() || !ui) return;
    const mine = ++generation;
    vetState = "pending";
    const verdict = await vet(ctx.modelRegistry, config.jev, candidate);
    if (mine !== generation || !ui) return;
    vetState = verdict.show ? "approved" : "vetoed";
    lastVerdict = `"${candidate.suggestion}": ${vetState} (${verdict.reason})`;
    if (!verdict.show) return;
    // A draft in the editor: keep the suggestion on offer, out of sight, so it appears once the
    // editor is empty again (the draft stashed with pi-stash's Ctrl+S, or deleted).
    if (ui.getEditorText() === "") show(candidate.suggestion);
    else { conceal(); offered = candidate.suggestion; offerSource = undefined; }
  });

  pi.registerCommand("next-prompt", {
    description: "next-prompt: status, on, or off (this session)",
    getArgumentCompletions: (prefix: string) =>
      ["status", "on", "off"].filter((o) => o.startsWith(prefix)).map((o) => ({ value: o, label: o })),
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg === "on" || arg === "off") {
        sessionOn = arg === "on";
        if (!sessionOn) reset();
        ctx.ui.notify(`next-prompt ${arg} for this session`, "info");
        return;
      }
      if (arg && arg !== "status") {
        ctx.ui.notify("Usage: /next-prompt [status|on|off]", "warning");
        return;
      }
      ctx.ui.notify(
        `next-prompt ${active() ? "on" : "off"}. Instruction: ${instruction}. Latest assistant: ${lastTag}. ` +
        `Settlement: ${outcome ?? "not observed (agent_before_settle)"}; agent_settled ${settled ? "observed" : "not observed"}. Vet: ${vetState}. ` +
        `UI: ${uiState}. Focus: ${focusState()}${ui && !mainFocused() ? " (ghost/acceptance blocked)" : ""}. Editor: ${ui ? ui.getEditorText() === "" ? "empty" : "nonempty (display blocked)" : "unavailable"}. ` +
        `Offer: ${shown ? patched ? "ghost text" : "fallback widget" : offered ? "concealed" : "none"}. ` +
        `Explicit: ${explicit ? `${explicit.id} ${explicit.acknowledged ? "rendered" : "awaiting render"}${busy ? " (accept after turn)" : ""}` : "none"}; last acknowledgement/blocker: ${lastExplicit}. ` +
        `Last suggestion: ${lastVerdict || "none yet"}.`,
        "info",
      );
    },
  });
}

function keyLabel(key: string) {
  return key
    .split("+")
    .map((part) => (part.length === 1 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join("+");
}
