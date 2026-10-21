// Sidebar: a live, read-only side chat beside a working Pi session, in the same Pi process.
//
// Ctrl+' opens Sidebar in half of Pi's fullscreen layout (main reflows into the other half) or moves
// focus between the two. Every Sidebar request is main's last provider request plus Sidebar's part,
// so main's prompt cache serves it; it never changes anything, and it asks before a request would
// re-read main's context uncached.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FOCUS_KEYS_ENV, KEYS_ENV, parseFocusKeys, parseKeys } from "./config.ts";
import { subagentsGuarded } from "./child.ts";
import { QUIZ_HELP, SidebarController } from "./controller.ts";
import { HEADSUP_HELP } from "./headsup/headsup.ts";
import { GUARD_ENV, judgeCall, SUBAGENT_ENV_CHANNEL, type SubagentEnvRequest } from "./guard.ts";

/**
 * Inside a subagent Sidebar started (GUARD_ENV set by the pi-subagents contract), pi-sidebar only
 * guards: every tool call goes through the same read-only judgment as in Sidebar.
 */
export function installGuardOnly(pi: ExtensionAPI): void {
  pi.events.on(SUBAGENT_ENV_CHANNEL, (data: unknown) => {
    const request = data as Partial<SubagentEnvRequest> | undefined;
    if (request?.version === 1 && !request.probe && request.env) request.env[GUARD_ENV] = "1";
  });
  pi.on("tool_call", async (event, ctx) => {
    const verdict = await judgeCall(event.toolName, event.input, {
      cwd: ctx.cwd,
      registry: ctx.modelRegistry,
      tool: (name) => pi.getAllTools().find((tool) => tool.name === name),
      subagentsGuarded: () => subagentsGuarded(pi.events),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return verdict.allowed ? undefined : { block: true, reason: verdict.reason };
  });
}

const COMMAND_HELP = [
  "/sidebar        open Sidebar, or hide it (its thread is kept)",
  "/sidebar new    start a fresh Sidebar thread",
  "/sidebar quiz   quiz mode: Sidebar quizzes you on main's changes (next | progress | off)",
  "/sidebar headsup  heads-up checks: one thing worth knowing, above main's editor (on | off)",
  "/sidebar model  why Sidebar always uses main's model",
  "Ctrl+'          open or close Sidebar (in Herdr, prefix+h/l moves between main and Sidebar)",
].join("\n");

const MODEL_NOTE =
  "Sidebar always uses main's model and thinking settings: a provider's prompt cache belongs to one model and one set of settings, so anything else would re-read main's whole context uncached on every question.";

export default function piSidebar(pi: ExtensionAPI) {
  if (process.env[GUARD_ENV] === "1") return installGuardOnly(pi);
  const keys = parseKeys(process.env[KEYS_ENV]);
  const sidebar = new SidebarController(pi, keys, parseFocusKeys(process.env[FOCUS_KEYS_ENV]));

  for (const key of keys) {
    pi.registerShortcut(key as never, {
      description: "Open or close Sidebar, a read-only side chat beside this session",
      handler: (ctx) => sidebar.toggle(ctx),
    });
  }

  pi.registerCommand("sidebar", {
    description: "Open or hide Sidebar, a live read-only side chat beside this session (new | quiz | headsup | model | help)",
    getArgumentCompletions: (prefix: string) =>
      ["new", "quiz", "quiz next", "quiz progress", "quiz off", "headsup", "headsup on", "headsup off", "model", "help"].filter((a) => a.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "help") ctx.ui.notify(`${COMMAND_HELP}\n\nIn Sidebar:\n${QUIZ_HELP}\n\n${HEADSUP_HELP}`, "info");
      else if (sub === "headsup" || sub.startsWith("headsup ")) {
        const arg = sub.slice("headsup".length).trim();
        if (arg === "on" || arg === "off") {
          sidebar.headsUp.setOn(arg === "on");
          ctx.ui.notify(arg === "on" ? "Heads-up mode is on for this session." : "Heads-up mode is off for this session.", "info");
        } else if (arg === "") ctx.ui.notify(sidebar.headsUp.summary(), "info");
        else ctx.ui.notify(`Unknown /sidebar headsup argument "${arg}".\n${HEADSUP_HELP}`, "warning");
      }
      else if (sub === "quiz" || sub.startsWith("quiz ")) {
        sidebar.openOrFocus(ctx);
        if (sidebar.isOpen) await sidebar.quizCommand(sub.slice("quiz".length));
      }
      else if (sub === "model" || sub.startsWith("model ") || sub.startsWith("thinking")) ctx.ui.notify(MODEL_NOTE, "info");
      else if (sub === "new") {
        await sidebar.reset();
        sidebar.openOrFocus(ctx);
      } else if (!sub) sidebar.toggle(ctx);
      else ctx.ui.notify(`Unknown /sidebar argument "${sub}".\n${COMMAND_HELP}`, "warning");
    },
  });
}
