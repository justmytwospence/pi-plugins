// Explicit foreground handoff; suggestion UI remains owned by optional pi-next-prompt.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { failure, handoff, interactiveCommand, type HandoffResult } from "./handoff.ts";
import { createFocusProxy, layoutShape, resolveTranscript, TranscriptPanels } from "./transcript.ts";

export default function interactiveShell(pi: ExtensionAPI) {
  const terminalAvailable = () => process.stdin.isTTY === true && process.stdout.isTTY === true;
  let available = false;
  let terminal: unknown;
  let lastHandoff = "none";
  const inspect = () => {
    const resolved = resolveTranscript(terminal);
    return {
      available: available && terminalAvailable() && "chat" in resolved,
      layout: "chat" in resolved ? "inline" : "unsupported",
      ...("chat" in resolved ? { source: resolved.source } : { reason: resolved.reason }),
      shape: "chat" in resolved ? layoutShape(terminal) : resolved.shape,
      rendererMode: layoutShape(terminal).rendererMode,
      lastHandoff,
    };
  };
  let sessionActive = false;
  let generation = 0;
  const transcript = new TranscriptPanels();
  let acceptedDraft: string | undefined;
  const clearAccepted = () => { acceptedDraft = undefined; generation++; };
  pi.events.on("interactive-shell:suggestion-accepted", (data) => {
    const text = (data as { text?: unknown } | undefined)?.text;
    acceptedDraft = sessionActive && typeof text === "string" && text.startsWith("!i ") ? text : undefined;
  });
  pi.on("input", clearAccepted);
  pi.on("session_tree", clearAccepted);
  pi.on("agent_start", clearAccepted);
  let pending: Promise<HandoffResult> | undefined;
  let active: ReturnType<typeof handoff> | undefined;
  // Background completions may request a turn while the terminal belongs to the
  // child. Defer its model request instead of running tools behind the handoff.
  pi.on("before_agent_start", async () => {
    if (!pending) return;
    await pending;
    // Give Pi's user_bash continuation a chance to record the completion status.
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
  pi.on("session_start", (_event, ctx) => {
    clearAccepted();
    sessionActive = true;
    available = ctx.mode === "tui" && ctx.hasUI && terminalAvailable();
    terminal = undefined;
    if (ctx.mode === "tui" && ctx.hasUI) {
      ctx.ui.setWidget("interactive-shell-probe", (tui) => {
        terminal = tui;
        return { render: () => [], invalidate() {} };
      }, { placement: "belowEditor" });
      ctx.ui.setWidget("interactive-shell-probe", undefined);
    }
  });
  pi.on("session_shutdown", async () => {
    sessionActive = false;
    clearAccepted();
    available = false;
    terminal = undefined;
    await active?.shutdown();
    await pending;
    transcript.clear();
  });
  // Probe during before_agent_start: the capability exists even though that run is busy.
  pi.events.on("interactive-shell:probe", (data) => {
    const request = data as { reply?: unknown } | undefined;
    if (inspect().available && typeof request?.reply === "function") request.reply();
  });
  pi.events.on("interactive-shell:inspect", (data) => {
    const request = data as { reply?: unknown } | undefined;
    if (typeof request?.reply === "function") request.reply(inspect());
  });
  pi.registerCommand("interactive-shell", {
    description: "Show inline terminal availability and last handoff path",
    handler: async (args, ctx) => {
      if (args.trim() !== "status") {
        ctx.ui.notify("Usage: /interactive-shell status", "warning");
        return;
      }
      ctx.ui.notify(`interactive-shell: ${JSON.stringify(inspect())}`, "info");
    },
  });
  pi.on("user_bash", async (event, ctx) => {
    const autoClose = !event.excludeFromContext && `!${event.command}` === acceptedDraft;
    clearAccepted();
    const mine = generation;
    const command = interactiveCommand(event.command);
    if (command === undefined) return undefined;
    pi.events.emit("prompt:clear", {});
    if (!command) return { result: failure("usage: !i <command>") };
    if (ctx.mode !== "tui" || !ctx.hasUI || !terminalAvailable()) {
      return { result: failure("requires an interactive terminal") };
    }
    if (pending || !ctx.isIdle()) return { result: failure("wait for the current operation to finish before handing over the terminal") };
    // Pi records this result and honors event.excludeFromContext for !!i itself.
    let started = false;
    pending = ctx.ui.custom<HandoffResult>((tui, theme, _kb, done) => {
      const resolved = resolveTranscript(tui);
      if (!("chat" in resolved)) {
        done(failure(`inline terminal unavailable: ${resolved.reason}; command was not run`));
        return { render: () => [], invalidate() {} };
      }
      const { chat } = resolved;
      const panel = handoff(tui, theme, command, event.cwd, (result, snapshot) => {
        if (snapshot) transcript.replace(chat, panel, snapshot);
        tui.requestRender();
        done(result);
      }, true, true, () => { started = true; lastHandoff = `inline (${resolved.source})`; });
      active = panel;
      transcript.insert(chat, panel);
      return createFocusProxy(panel);
    }, { overlay: false });
    try {
      const result = await pending;
      if (started && autoClose && sessionActive) setImmediate(() => {
        if (!sessionActive || mine !== generation || !ctx.isIdle()) return;
        generation++;
        pi.sendMessage({
          customType: "interactive-shell-continuation",
          content: "The requested interactive command has finished. Continue based on its recorded exit status; its terminal output was not captured.",
          display: false,
        }, { triggerTurn: true });
      });
      return { result };
    }
    finally { pending = undefined; active = undefined; }
  });
}
