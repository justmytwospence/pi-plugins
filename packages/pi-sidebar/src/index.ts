// Sidebar: a live, read-only side chat beside a working Pi session, in the same Pi process.
//
// Ctrl+' opens Sidebar in half of Pi's fullscreen layout (main reflows into the other half) or moves
// focus between the two. Every Sidebar request is main's last provider request plus Sidebar's part,
// so main's prompt cache serves it (or, on another model you pick with /model, main's session as a
// transcript with that model's own cache); it never changes anything, and it asks before a request
// would re-read main's context uncached.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installEnvironmentObserver } from "./family/observer.ts";
import { OBSERVER_ENV } from "./family/protocol.ts";
import { FOCUS_KEYS_ENV, KEYS_ENV, parseFocusKeys, parseKeys } from "./config.ts";
import { subagentsGuarded } from "./child.ts";
import { MODEL_HELP, QUIZ_HELP, SIDEBAR_HEADSUP_HELP, SidebarController } from "./controller.ts";
import { HEADSUP_HELP, headsUpChange, headsUpChanged } from "./headsup/headsup.ts";
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
  "/sidebar headsup  heads-up checks: one thing worth knowing, in Sidebar or above main's editor (on | sidebar | off)",
  "/sidebar model  Sidebar's model: main's own (same, sharing its cache) or a favorite (model <name> | model same)",
  "Ctrl+'          open or close Sidebar (in Herdr, prefix+h/l moves between main and Sidebar)",
].join("\n");

export default function piSidebar(pi: ExtensionAPI) {
  if (process.env[OBSERVER_ENV]) {
    installEnvironmentObserver(pi);
    if (process.env[GUARD_ENV] === "1") installGuardOnly(pi);
    return;
  }
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
    getArgumentCompletions: (prefix: string) => {
      const models = sidebar.favorites().flatMap((f) => (f.model ? [`model ${f.model.id}`] : []));
      return ["new", "quiz", "quiz next", "quiz progress", "quiz off", "headsup", "headsup on", "headsup off", "model", "model same", ...models, "help"]
        .filter((a) => a.startsWith(prefix.trimStart()))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "help") ctx.ui.notify(`${COMMAND_HELP}\n\nIn Sidebar:\n${MODEL_HELP}\n${QUIZ_HELP}\n${SIDEBAR_HEADSUP_HELP}\n\n${HEADSUP_HELP}`, "info");
      else if (sub === "headsup" || sub.startsWith("headsup ")) {
        const arg = sub.slice("headsup".length).trim();
        const change = headsUpChange(arg);
        if (change) {
          sidebar.headsUp.setOn(change.on);
          ctx.ui.notify(headsUpChanged(change), "info");
        } else if (arg === "") ctx.ui.notify(sidebar.headsUp.summary(), "info");
        else ctx.ui.notify(`Unknown /sidebar headsup argument "${arg}".\n${HEADSUP_HELP}`, "warning");
      }
      else if (sub === "quiz" || sub.startsWith("quiz ")) {
        sidebar.openOrFocus(ctx);
        if (sidebar.isOpen) await sidebar.quizCommand(sub.slice("quiz".length));
      }
      else if (sub === "model" || sub.startsWith("model ")) {
        sidebar.main.bind(ctx);
        await sidebar.modelCommand(args.trim().slice("model".length), ctx);
      }
      else if (sub === "new") {
        await sidebar.reset();
        sidebar.openOrFocus(ctx);
      } else if (!sub) sidebar.toggle(ctx);
      else ctx.ui.notify(`Unknown /sidebar argument "${sub}".\n${COMMAND_HELP}`, "warning");
    },
  });
}
