// Explicit foreground handoff; suggestion UI remains owned by optional pi-next-prompt.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { failure, handoff, interactiveCommand, type HandoffResult } from "./handoff.ts";

export default function interactiveShell(pi: ExtensionAPI) {
  const terminalAvailable = () => process.stdin.isTTY === true && process.stdout.isTTY === true;
  let available = false;
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
    available = ctx.mode === "tui" && ctx.hasUI && terminalAvailable();
  });
  pi.on("session_shutdown", async () => {
    available = false;
    await active?.shutdown();
    await pending;
  });
  // Probe during before_agent_start: the capability exists even though that run is busy.
  pi.events.on("interactive-shell:probe", (data) => {
    const request = data as { reply?: unknown } | undefined;
    if (available && typeof request?.reply === "function") request.reply();
  });
  pi.on("user_bash", async (event, ctx) => {
    const command = interactiveCommand(event.command);
    if (command === undefined) return undefined;
    pi.events.emit("prompt:clear", {});
    if (!command) return { result: failure("usage: !i <command>") };
    if (ctx.mode !== "tui" || !ctx.hasUI || !terminalAvailable()) {
      return { result: failure("requires an interactive terminal") };
    }
    if (pending || !ctx.isIdle()) return { result: failure("wait for the current operation to finish before handing over the terminal") };
    // Pi records this result and honors event.excludeFromContext for !!i itself.
    pending = ctx.ui.custom<HandoffResult>((tui, theme, _kb, done) => {
      active = handoff(tui, theme, command, event.cwd, done);
      return active;
    }, { overlay: true, overlayOptions: () => active?.overlayOptions() ?? {} });
    try { return { result: await pending }; }
    finally { pending = undefined; active = undefined; }
  });
}
