// pi-marimo: keeps Pi aware of the marimo notebook you are working in.
//
// - Footer: `marimo: <current file> · running <section> (12s) · 2 queued · 1 error · also <file>, <file>`
//   through ctx.ui.setStatus("marimo", ...), so it shows in Pi's own footer and
//   any footer that reads extension statuses.
// - Context: the notebooks' state, taken when you send a prompt, sits right
//   after that prompt for the whole turn. It is never stored in the session, so
//   the model sees only the current turn's copy and old copies never pile up.
// - /marimo: pin notebooks, follow every notebook under the cwd, or turn it off.
// - marimo-lens (core/lens.ts): open selections enter the context and get their own status
//   (`marimo-lens`); a new one made while Pi is idle is offered as the next prompt through
//   pi-next-prompt (`prompt:offer`).
// - herdr (through pi-herdr): when a turn ends with a cell the agent started still running, the pane
//   token `marimo` says what runs until the kernel goes quiet, then a notification says it finished
//   (herdr.ts).
// - pi-bg: a busy notebook is outside work `bg_wait marimo:<path>` can wait on, pi-bg tasks that serve
//   or drive a followed notebook get its kernel state (bg:annotate), and a run a pi-bg
//   job drives (and will wake the agent about) gets no separate "finished" notification (bg.ts).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BgBridge } from "./bg.js";
import { KernelHold } from "./core/hold.js";
import { lensLines, lensStatusText, snapshot, STATE_TAG, statusParts, statusText } from "./core/render.js";
import { basename } from "./core/io.js";
import { nodeIo } from "./core/node-io.js";
import { pairTargets } from "./core/touch.js";
import { MarimoWatcher, type Mode, parseMode } from "./core/watcher.js";
import { HerdrHold } from "./herdr.js";
import { spawn } from "node:child_process";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION } from "./activity.js";
import { FULL_SCREEN } from "./ui/frame.js";
import { interruptKernel } from "./ui/interrupt.js";
import { PillView } from "./ui/pill.js";
import { NotebookSource } from "./ui/source.js";
import { NotebookView, type ViewActions } from "./ui/view.js";

const ENTRY = "pi-marimo";
const STATUS_KEY = "marimo";
// Open Lens selections get a status (and so a footer line) of their own.
const LENS_STATUS_KEY = "marimo-lens";
const OFFER_SOURCE = "pi-marimo";
const MESSAGE_TYPE = "pi-marimo-state";

type Entry = { type?: string; customType?: string; data?: unknown };

function savedMode(entries: readonly Entry[]): Mode | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== ENTRY) continue;
    const mode = parseMode((entry.data as { mode?: unknown } | undefined)?.mode);
    if (mode) return mode;
  }
  return undefined;
}

/**
 * Where this turn's state block goes: right after the prompt that started the
 * turn (the last user message when the turn's first request is built). It stays
 * there, unchanged, for every request of the turn, so the thinking the model
 * writes after it stays valid: Anthropic drops a thinking block when anything
 * before it changes. At the next prompt the old block is gone (it is never
 * stored), which drops that earlier turn's thinking once.
 */
export function insertState<M extends { role?: string; timestamp?: number }>(messages: M[], block: M, anchor: number | undefined): { messages: M[]; anchor: number | undefined } {
  let at = -1;
  if (anchor !== undefined) at = messages.findIndex((m) => m.role === "user" && m.timestamp === anchor);
  if (at < 0) {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { at = i; break; }
    anchor = at >= 0 ? messages[at]?.timestamp : undefined;
  }
  if (at < 0) return { messages: [...messages, block], anchor };
  return { messages: [...messages.slice(0, at + 1), block, ...messages.slice(at + 1)], anchor };
}

/** With pi-bg loaded and a notebook running, tell the agent how to wait for it. */
export function withWaitHint(text: string, running: string[], pi: Pick<ExtensionAPI, "events">): string {
  if (!running.length) return text;
  let piBg = false;
  pi.events?.emit("bg:probe", { reply: () => { piBg = true; } });
  if (!piBg) return text;
  const hint = `To wait for a running notebook inside your turn, call bg_wait with its id: ${running.join(", ")}.`;
  const close = `</${STATE_TAG}>`;
  return text.endsWith(close) ? `${text.slice(0, -close.length).replace(/\n?$/u, "\n")}${hint}\n${close}` : `${text}\n${hint}`;
}

export default function piMarimo(pi: ExtensionAPI): void {
  let watcher: MarimoWatcher | undefined;
  let ctxRef: ExtensionContext | undefined;
  // Per notebook path: browser edits after this change number are flagged as new.
  const seen = new Map<string, number>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let lastStatus: string | undefined;
  let lastLensStatus: string | undefined;
  // Lens selections (path + selection id) already seen, so only new ones are offered as a next prompt.
  const lensSeen = new Set<string>();
  let offering = false;
  let busy = false;
  // The state taken when the current turn's prompt was sent, and that prompt's timestamp.
  let turn: { text: string; anchor?: number } | undefined;
  // A cell the agent started that outlives its turn, shown in herdr (interactive sessions only).
  const hold = new KernelHold();
  let herdr: HerdrHold | undefined;
  pi.events?.on("herdr:ready", () => herdr?.resend());
  const bg = new BgBridge(pi.events, (command) => watcher?.targeted(pairTargets(command)) ?? []);
  pi.events?.on("bg:tasks", (data) => {
    bg.onTasks((data as { tasks?: unknown } | undefined)?.tasks);
    if (hold.active) bg.noteCovered(hold.paths);
    if (watcher && ctxRef) bg.annotate(watcher.followed(), ctxRef.cwd);
  });

  // The notebooks as background work (ui/source.ts): rows in pi-bg's /tasks view, a pill under the
  // prompt while one is busy, and a full-screen view of each (ui/view.ts).
  const viewActions: ViewActions = {
    followed: () => watcher?.followed() ?? [],
    interrupt: (f) => interruptKernel(f.attachment, process.env.MARIMO_TOKEN),
    openInBrowser: (f) => {
      const url = `${f.attachment.url}/?file=${encodeURIComponent(f.attachment.path)}`;
      try {
        spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
      } catch {
        // No opener: nothing to do.
      }
    },
  };
  const openView = (key: string, ui: unknown): Promise<void> =>
    (ui as ExtensionContext["ui"]).custom<void>((tui, theme, _keys, done) => new NotebookView(tui, theme, key, viewActions, () => done(undefined)), FULL_SCREEN);
  const source: NotebookSource = new NotebookSource({
    followed: viewActions.followed,
    open: openView,
    interrupt: viewActions.interrupt,
    changed: () => {
      pi.events?.emit(ACTIVITY_CHANGED, { id: source.section.id });
      ownPill.update();
    },
    hostedChanged: () => bindPill(),
  });
  const ownPill = new PillView({
    pill: (now) => source.pill(now),
    open: () => {
      if (ctxRef) void source.section.openDialog?.(ctxRef.ui).catch(() => undefined);
    },
  });
  /** pi-marimo draws its own pill only in the TUI, and only while no host (pi-subagents, pi-bg) shows it. */
  const bindPill = () => {
    ownPill.setUI(ctxRef?.mode === "tui" && !source.hosted ? (ctxRef.ui as never) : undefined);
    ownPill.update();
  };
  const offer = () => {
    if (ctxRef?.mode === "tui") pi.events?.emit(ACTIVITY_SECTION, { section: source.section });
  };
  pi.events?.on(ACTIVITY_HOST, () => offer());
  pi.events?.on(ACTIVITY_GONE, (data) => {
    const id = (data as { id?: string } | undefined)?.id;
    if (id && id !== source.section.id) source.section.setHosted?.(false, id);
  });

  const statusLine = (): string | undefined => {
    if (!watcher) return undefined;
    const { connection, attachment, mode } = watcher;
    if (!attachment) return undefined;
    if (connection === "searching") {
      return mode.kind === "pinned" ? statusText({ notebook: mode.paths.map((p) => p.split("/").pop()).join(", "), connection: "not open", queued: 0, errors: 0 }) : undefined;
    }
    return statusText(statusParts(watcher.notebook, attachment, connection, Date.now(), watcher.others()));
  };

  const render = (): void => {
    pending = undefined;
    if (hold.active && watcher) {
      const held = hold.paths;
      let change = hold.update(watcher.followed(), Date.now());
      // A pi-bg job that drove these runs wakes the agent about their end: no second notice.
      if (change.kind === "finished" && bg.coversAll(held)) change = { kind: "released" };
      void herdr?.apply(change);
    }
    if (watcher && ctxRef) {
      bg.external(watcher.followed(), ctxRef.cwd);
      bg.annotate(watcher.followed(), ctxRef.cwd);
      source.update(watcher.followed());
    }
    const text = statusLine();
    if (text !== lastStatus) {
      lastStatus = text;
      ctxRef?.ui.setStatus(STATUS_KEY, text);
    }
    lensUpdate();
    // Tick the elapsed time while a cell runs, and while a run waits out a disconnect.
    const running = (watcher?.connection === "connected" && watcher.notebook.running()) || bg.needsTick();
    if (running && !ticker) ticker = setInterval(render, 1000);
    if (!running && ticker) { clearInterval(ticker); ticker = undefined; }
  };

  /** The Lens footer line, and a next-prompt offer when the user marks something new while Pi is idle. */
  const lensUpdate = (): void => {
    const connected = (watcher?.followed() ?? []).filter((f) => f.connection === "connected");
    const lens = lensStatusText(connected);
    if (lens !== lastLensStatus) {
      lastLensStatus = lens;
      ctxRef?.ui.setStatus(LENS_STATUS_KEY, lens);
    }
    // Selections made during a turn wait for it to end; the turn may have addressed them.
    const fresh: Array<{ path: string; label: string; key: string }> = [];
    let open = 0;
    for (const f of connected) {
      for (const s of f.notebook.lens.selections()) {
        open++;
        const key = `${f.attachment.path}\0${s.id}`;
        if (!lensSeen.has(key)) fresh.push({ path: f.attachment.path, label: s.label, key });
      }
    }
    if (!open && offering) {
      offering = false;
      pi.events?.emit("prompt:offer", { source: OFFER_SOURCE });
    }
    if (!fresh.length || busy || ctxRef?.mode !== "tui") return;
    for (const f of fresh) lensSeen.add(f.key);
    const files = [...new Set(fresh.map((f) => basename(f.path)))];
    const first = fresh[0]!;
    const text = fresh.length === 1
      ? `Use Lens to address ${first.label} in ${basename(first.path)}`
      : `Use Lens to address my open selections in ${files.join(" and ")}`;
    offering = true;
    pi.events?.emit("prompt:offer", { source: OFFER_SOURCE, text });
  };

  const schedule = (): void => {
    if (!ctxRef) return;
    pending ??= setTimeout(render, 150);
  };

  /** The followed notebooks that are connected, the current one first. */
  const stateEntries = () =>
    (watcher?.followed() ?? [])
      .filter((f) => f.connection === "connected" && f.notebook.ready)
      .map((f) => ({ notebook: f.notebook, attachment: f.attachment, current: f.current, seenSeq: seen.get(f.attachment.path) ?? 0 }));

  const setMode = (mode: Mode): void => {
    pi.appendEntry(ENTRY, { mode });
    watcher?.setMode(mode);
    schedule();
  };

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    herdr = ctx.mode === "tui" ? new HerdrHold(pi.events) : undefined;
    await watcher?.stop();
    watcher = new MarimoWatcher({ io: nodeIo(), cwd: ctx.cwd, token: process.env.MARIMO_TOKEN, onChange: schedule });
    watcher.mode = savedMode(ctx.sessionManager.getBranch() as Entry[]) ?? { kind: "auto" };
    watcher.start();
    source.resetHosts();
    bindPill();
    offer();
  });

  // The user's next message: failed runs they had a chance to see stop alerting.
  pi.on("input", (event) => {
    if ((event as { source?: string }).source === "interactive") source.seen();
  });

  pi.on("session_shutdown", async () => {
    const previousContext = ctxRef;
    ctxRef = undefined;
    const previousWatcher = watcher;
    watcher = undefined;
    if (pending) clearTimeout(pending);
    if (ticker) clearInterval(ticker);
    pending = ticker = undefined;
    await herdr?.apply(hold.release());
    bg.stopAll();
    if (previousContext?.mode === "tui") pi.events?.emit(ACTIVITY_GONE, { id: source.section.id });
    ownPill.dispose();
    source.resetHosts();
    await previousWatcher?.stop();
    previousContext?.ui.setStatus(STATUS_KEY, undefined);
    previousContext?.ui.setStatus(LENS_STATUS_KEY, undefined);
    lastStatus = lastLensStatus = undefined;
    lensSeen.clear();
    offering = busy = false;
  });

  pi.on("before_agent_start", async () => {
    turn = undefined;
    if (!watcher) return;
    watcher.refresh();
    await watcher.settle(2000);
    const entries = stateEntries();
    // Bring the running list up to date first: a cell may have started within the last render's debounce.
    if (ctxRef) bg.external(watcher.followed(), ctxRef.cwd);
    turn = entries.length ? { text: withWaitHint(snapshot(entries, { refresh: "prompt" }), bg.runningIds(), pi) } : undefined;
  });

  // The notebook this session's agent works in (through marimo-pair) becomes current for this
  // session, whatever other sessions or the browser do. Nested calls (codemode) arrive here too.
  pi.on("tool_call", (event) => {
    const targets = pairTargets(JSON.stringify(event.input ?? {}));
    if (targets.length) watcher?.touch(targets);
    return undefined;
  });

  pi.on("agent_start", () => {
    busy = true;
    offering = false;
    void herdr?.apply(hold.begin(Date.now()));
    bg.resetHold();
  });

  // The agent is done for now: a cell it started that still runs holds the pane's attention.
  pi.on("agent_settled", (_event, ctx) => {
    if (!watcher || ctx.isIdle() !== true) return;
    busy = false;
    schedule();
    void herdr?.apply(hold.end(watcher.followed(), Date.now()));
    bg.noteCovered(hold.paths);
  });

  // Browser edits made after this point are flagged as new in the next turn.
  pi.on("agent_end", () => {
    for (const f of watcher?.followed() ?? []) seen.set(f.attachment.path, f.notebook.seq);
  });

  pi.on("context", (event) => {
    if (!turn) return undefined;
    const block = { role: "custom", customType: MESSAGE_TYPE, content: turn.text, display: false, timestamp: 0 } as (typeof event.messages)[number];
    const placed = insertState(event.messages as Array<{ role?: string; timestamp?: number }>, block as { role?: string; timestamp?: number }, turn.anchor);
    turn.anchor = placed.anchor;
    return { messages: placed.messages as typeof event.messages };
  });

  pi.registerCommand("marimo", {
    description: "Choose the marimo notebooks Pi follows (view, auto, off, show, lens)",
    getArgumentCompletions: (prefix) =>
      ["view", "auto", "off", "show", "lens"].filter((a) => a.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!watcher) return;
      const arg = args.trim();
      if (arg === "auto") { setMode({ kind: "auto" }); ctx.ui.notify("marimo: following every notebook open under this directory", "info"); return; }
      if (arg === "off") { setMode({ kind: "off" }); ctx.ui.notify("marimo: off", "info"); return; }
      if (arg === "view") {
        const path = source.busiest();
        if (!path) ctx.ui.notify("marimo: no notebook followed", "info");
        else await openView(path, ctx.ui);
        return;
      }
      if (arg === "lens") {
        const parts = stateEntries().map((e) => ({ path: e.attachment.path, lines: lensLines(e.notebook) })).filter((p) => p.lines.length);
        ctx.ui.notify(parts.length ? parts.map((p) => [p.path, ...p.lines].join("\n")).join("\n\n") : "marimo: no Lens selections in the followed notebooks", "info");
        return;
      }
      if (arg === "show") {
        const entries = stateEntries();
        ctx.ui.notify(entries.length ? snapshot(entries, { refresh: "prompt" }) : statusLine() ?? "marimo: no notebook attached", "info");
        return;
      }
      // A checklist: pick notebooks to pin one at a time, then Done.
      const open = [...new Map((await watcher.list()).map((n) => [n.path, n])).values()];
      const pinned = new Set(watcher.mode.kind === "pinned" ? watcher.mode.paths : []);
      for (const p of pinned) if (!open.some((n) => n.path === p)) open.push({ url: "", sessionId: "", path: p });
      const done = "Done";
      const auto = `Auto: every notebook open under ${ctx.cwd}`;
      const off = "Off";
      for (;;) {
        const labels = open.map((n) => `${pinned.has(n.path) ? "[x]" : "[ ]"} ${n.path}${n.url ? "" : "  (not open)"}`);
        const choice = await ctx.ui.select("Notebooks for Pi to follow (pick to toggle)", [done, ...labels, auto, off]);
        if (choice === undefined) return;
        if (choice === auto) return setMode({ kind: "auto" });
        if (choice === off) return setMode({ kind: "off" });
        if (choice === done) return setMode(pinned.size ? { kind: "pinned", paths: [...pinned] } : { kind: "auto" });
        const notebook = open[labels.indexOf(choice)];
        if (!notebook) continue;
        if (pinned.has(notebook.path)) pinned.delete(notebook.path);
        else pinned.add(notebook.path);
      }
    },
  });
}
