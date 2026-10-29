// pi-marimo: keeps Pi aware of the marimo notebook you are working in.
//
// - Footer: a status per notebook this session uses, `marimo: <file> · running <section> (12s) ·
//   2 queued · 1 error`, through ctx.ui.setStatus("marimo", ...), then "marimo-2", "marimo-3", ...
//   in file order, so each gets its own line in footers that lay them out (pi-status-footer) and
//   all show in Pi's own footer. A running server whose notebook is open in no browser gets a
//   `not open` line too, its name an OSC 8 link that a click opens (waiting.ts); `/marimo open` is
//   the keyboard path.
// - Session scope: footer, Lens and context cover only the notebooks this session uses (pinned, or
//   worked in by its agent through marimo-pair, saved with the session). Other notebooks open under
//   the cwd, such as one another session in this checkout works in, get a one-line mention in context.
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
import { busy as kernelBusy, KernelHold } from "./core/hold.js";
import { ambiguityNote, lensLines, lensStatusText, shortWhere, snapshot, STATE_TAG, statusParts, statusText } from "./core/render.js";
import { basename } from "./core/io.js";
import { nodeIo } from "./core/node-io.js";
import { HeadlessSessions } from "./core/headless.js";
import { pairTargets, sameServer } from "./core/touch.js";
import { MarimoWatcher, type Mode, type Waiting, parseMode } from "./core/watcher.js";
import { HerdrHold } from "./herdr.js";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION, stoppable } from "./activity.js";
import { FULL_SCREEN } from "./frame.ts";
import { interruptKernel, runCells } from "./ui/interrupt.js";
import { PillView } from "./pill.ts";
import { notebookKey } from "./ui/identity.js";
import { NotebookSource, type Unopened } from "./ui/source.js";
import { openUrl, waitingStatus, waitingUrl } from "./waiting.js";
import { NotebookView, type ViewActions } from "./ui/view.js";
import { ChatChart, type ChartEntry, disposeCharts, latestChart } from "./ui/chat-chart.js";
import { VegaRenderer } from "./core/vega.js";
import type { Followed } from "./core/watcher.js";
import { Type } from "typebox";

const ENTRY = "pi-marimo";
const STATUS_KEY = "marimo";
/** The status key of a notebook's footer line: `marimo`, then `marimo-2`, `marimo-3`, ... */
const statusKey = (i: number): string => (i === 0 ? STATUS_KEY : `${STATUS_KEY}-${i + 1}`);
// Open Lens selections get a status (and so a footer line) of their own.
const LENS_STATUS_KEY = "marimo-lens";
const OFFER_SOURCE = "pi-marimo";
const MESSAGE_TYPE = "pi-marimo-state";
const CHART_ENTRY = "pi-marimo-chart";
/** Besides the current notebook, the ones worked in during this many latest prompts are in full in context. */
const FULL_PROMPTS = 3;

type Entry = { type?: string; customType?: string; data?: unknown };

function savedEngaged(entries: readonly Entry[]): string[] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== ENTRY) continue;
    const engaged = (entry.data as { engaged?: unknown } | undefined)?.engaged;
    if (Array.isArray(engaged)) return engaged.filter((p): p is string => typeof p === "string");
  }
  return [];
}

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
  /** Pi's TUI, captured through an empty widget, so transcript charts can ask for a redraw. */
  let tuiRef: { requestRender(): void } | undefined;
  const chartComponents = new Map<string, ChatChart>();
  const vega = new VegaRenderer();
  let inspectOff: (() => void) | undefined;

  /** A notebook cell's chart as a transcript entry: a Plotly figure to run live, else a picture. */
  const chartEntry = async (cellRef: string, notebook?: string): Promise<ChartEntry> => {
    const followed = watcher?.followed() ?? [];
    const pool: Followed[] = notebook ? followed.filter((f) => f.attachment.path.endsWith(notebook) || f.canonicalPath?.endsWith(notebook)) : followed;
    const ref = cellRef.trim();
    for (const f of pool) {
      const cell = f.notebook.ordered().find((c) => c.id === ref || c.name === ref);
      if (!cell) continue;
      const base = { path: f.attachment.path, cell: cell.id, label: cell.name !== "_" ? cell.name : cell.id };
      const out = cell.output;
      if (out?.plotly) return { ...base, plotly: out.plotly };
      if (out?.image) return { ...base, png: out.image.data };
      if (out?.vega) {
        const png = await new Promise<string | undefined>((resolve) => {
          const state = vega.request(out.vega!, () => { const s = vega.peek(out.vega!); resolve(s?.status === "ready" ? s.png : undefined); });
          if (state.status === "ready") resolve(state.png);
          else if (state.status === "failed") resolve(undefined);
        });
        if (png) return { ...base, png };
        return { ...base, note: "[chart: could not draw the Vega-Lite spec]" };
      }
      return { ...base, note: out ? `[no chart: the cell's output is ${out.text}]` : "[no output: run the cell first]" };
    }
    const names = pool.flatMap((f) => f.notebook.ordered().filter((c) => c.output?.plotly || c.output?.image || c.output?.vega).map((c) => (c.name !== "_" ? c.name : c.id)));
    throw new Error(`No cell "${ref}" in ${pool.length ? pool.map((f) => basename(f.attachment.path)).join(", ") : "the followed notebooks"}.${names.length ? ` Cells with charts: ${names.join(", ")}.` : ""}`);
  };

  /** Starts the keyboard pointer on the newest transcript chart; keys go to it until Esc. */
  const inspectLatest = (ui: ExtensionContext["ui"]): boolean => {
    const chart = latestChart();
    if (!chart?.inspect()) return false;
    inspectOff?.();
    inspectOff = ui.onTerminalInput((data) => {
      if (!chart.live.inspecting) { inspectOff?.(); inspectOff = undefined; return undefined; }
      chart.live.key(data);
      tuiRef?.requestRender();
      if (!chart.live.inspecting) { inspectOff?.(); inspectOff = undefined; ui.setStatus("marimo-inspect", undefined); }
      return { consume: true };
    });
    ui.setStatus("marimo-inspect", "chart: arrows or hjkl move · space drag · +/- zoom · 0 reset · esc done");
    tuiRef?.requestRender();
    return true;
  };
  // Per notebook path: browser edits after this change number are flagged as new.
  const seen = new Map<string, number>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let lastStatus: string[] = [];
  /** Notes for top-level tool calls whose marimo-pair calls were ambiguous, by call id. */
  const ambiguous = new Map<string, string>();
  /** Prompts sent so far, and the prompt in which this session's agent last worked in each notebook (by path). */
  let prompts = 0;
  const touchedAt = new Map<string, number>();
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
  const bg = new BgBridge(pi.events, (command) => watcher?.targeted(pairTargets(command)) ?? [], () => ctxRef?.mode === "tui");
  // A stopped job that drove a run: its client is gone but the cells still run, so stop them too.
  pi.events?.on("bg:killed", (data) => {
    const paths = bg.killed((data as { id?: unknown } | undefined)?.id);
    for (const f of watcher?.followed() ?? []) {
      if (paths.includes(f.attachment.path) && f.connection === "connected" && kernelBusy(f)) void interruptKernel(f.attachment, process.env.MARIMO_TOKEN).catch(() => undefined);
    }
  });
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
    openInBrowser: (f) => openUrl(`${f.attachment.url}/?file=${encodeURIComponent(f.attachment.path)}`),
    run: (f, cells) => runCells(f.attachment, cells, process.env.MARIMO_TOKEN),
    servers: (f) => bg.servers(f.attachment.path),
    stopServers: (f) => bg.stopServers(f.attachment.path),
    lastRun: (f) => source.lastRun(f),
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
    drivers: (f) => bg.drivers(f.attachment.path),
    servers: (f) => bg.servers(f.attachment.path),
    engaged: () => mine(),
    unopened: () => unopened(),
    openUrl,
    openUnopened: async (u) => {
      if (!u.server || !u.file) return;
      await attachWaiting({ url: u.server, path: u.file });
      const f = watcher?.followed().find((o) => o.attachment.path === u.file || o.canonicalPath === u.file);
      if (f) await openView(notebookKey(f), ctxRef?.ui);
    },
  });
  const ownPill = new PillView({
    pill: (now) => source.pill(now),
    open: () => (ctxRef ? source.section.openDialog?.(ctxRef.ui)?.catch(() => undefined) : undefined),
    openRow: (key) => (ctxRef ? source.section.open(key, ctxRef.ui).catch(() => undefined) : undefined),
    canStopRow: (row) => stoppable(source.section, row),
    stopRow: (key) => source.section.stop?.(key),
  }, "pi-marimo-pill");
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

  /** The followed notebooks this session uses, the current one first. */
  const mine = () => (watcher?.followed() ?? []).filter((f) => f.engaged);

  /** Notebooks this process opened without a browser (core/headless.ts), so marimo-pair has a session to talk to. */
  const headless = new HeadlessSessions();
  /** Opens a waiting notebook's session on its server, and waits for the watcher to follow it. */
  const attachWaiting = async (w: Pick<Waiting, "url" | "path">): Promise<void> => {
    await headless.attach(w.url, w.path, process.env.MARIMO_TOKEN);
    watcher?.refresh();
    await watcher?.settle(3000);
  };
  /** The waiting notebooks a marimo-pair call names (by server, by file, or both). */
  const waitingFor = (targets: ReturnType<typeof pairTargets>): Waiting[] => {
    const out = new Map<string, Waiting>();
    for (const t of targets) {
      if (t.unresolved || (!t.url && !t.file)) continue;
      for (const w of watcher?.waiting() ?? []) {
        const file = t.file;
        const fileOk = !file || w.path === file || w.canonicalPath === file || w.path.endsWith(`/${file}`) || w.canonicalPath.endsWith(`/${file}`);
        const urlOk = !t.url || sameServer(t.url, w.url);
        if (fileOk && urlOk) out.set(`${w.url}\0${w.path}`, w);
      }
    }
    return [...out.values()];
  };

  /** Notebooks with no session to follow: running servers open in no browser, and pinned files not open. */
  const unopened = (): Unopened[] => {
    if (!watcher) return [];
    const out: Unopened[] = [];
    const waiting = watcher.waiting();
    for (const w of waiting) out.push({ key: `waiting:${w.url}\0${w.canonicalPath}`, path: w.canonicalPath, where: shortWhere(w.url), state: "not open", url: waitingUrl(w), server: w.url, file: w.path });
    const { mode } = watcher;
    if (mode.kind === "pinned") {
      const open = new Set([...watcher.followed().flatMap((f) => [f.attachment.path, f.canonicalPath]), ...waiting.flatMap((w) => [w.path, w.canonicalPath, w.pinned ?? w.path])]);
      for (const p of mode.paths) if (!open.has(p)) out.push({ key: `pinned:${p}`, path: p, state: "not open" });
    }
    return out;
  };

  /**
   * One footer line per notebook this session uses, per pinned one that is not open, and per
   * running server whose notebook is open in no browser (watcher.waiting), in file order so the
   * lines hold still while the agent moves between notebooks.
   */
  const statusLines = (): string[] => {
    if (!watcher) return [];
    const now = Date.now();
    const lines = mine().map((f) => ({ path: f.attachment.path, text: statusText(statusParts(f.notebook, f.attachment, f.connection, now)) }));
    const { mode } = watcher;
    const waiting = watcher.waiting();
    for (const w of waiting) lines.push({ path: w.canonicalPath, text: waitingStatus(w) });
    if (mode.kind === "pinned") {
      const open = new Set([...watcher.followed().flatMap((f) => [f.attachment.path, f.canonicalPath]), ...waiting.flatMap((w) => [w.path, w.canonicalPath, w.pinned ?? w.path])]);
      for (const p of mode.paths) if (!open.has(p)) lines.push({ path: p, text: statusText({ notebook: basename(p), connection: "not open", queued: 0, errors: 0 }) });
    }
    return lines.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((l) => l.text);
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
    // In the TUI the notebooks are rows under the prompt (ui/source.ts); other modes keep the footer lines.
    const lines = ctxRef?.mode === "tui" ? [] : statusLines();
    for (let i = 0; i < Math.max(lines.length, lastStatus.length); i++) {
      if (lines[i] !== lastStatus[i]) ctxRef?.ui.setStatus(statusKey(i), lines[i]);
    }
    lastStatus = lines;
    lensUpdate();
    // Tick the elapsed time while a cell runs, and while a run waits out a disconnect.
    const running = (watcher?.followed() ?? []).some((f) => f.connection === "connected" && f.notebook.running()) || bg.needsTick();
    if (running && !ticker) ticker = setInterval(render, 1000);
    if (!running && ticker) { clearInterval(ticker); ticker = undefined; }
  };

  /** The Lens footer line, and a next-prompt offer when the user marks something new while Pi is idle. */
  const lensUpdate = (): void => {
    const connected = mine().filter((f) => f.connection === "connected");
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

  /** Whether this session's agent worked in a notebook during one of the last FULL_PROMPTS prompts. */
  const recent = (path: string): boolean => prompts - (touchedAt.get(path) ?? Number.NEGATIVE_INFINITY) < FULL_PROMPTS;

  /** The followed notebooks that are connected (only this session's with `own`), the current one first. */
  const stateEntries = (own = false) =>
    (watcher?.followed() ?? [])
      .filter((f) => f.connection === "connected" && f.notebook.ready && (!own || f.engaged))
      // Ranked, so the first is the current one. It is in full, and so is every other notebook the
      // agent worked in during the last few prompts; the rest are outlines, so the block stays small.
      .map((f, i) => ({ notebook: f.notebook, attachment: f.attachment, current: i === 0, full: i === 0 || recent(f.attachment.path), seenSeq: seen.get(f.attachment.path) ?? 0 }));

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
    const branch = ctx.sessionManager.getBranch() as Entry[];
    watcher.mode = savedMode(branch) ?? { kind: "auto" };
    watcher.engage(savedEngaged(branch));
    watcher.start();
    if (ctx.mode === "tui") {
      ctx.ui.setWidget("pi-marimo-tui", (tui) => { tuiRef = tui; return { render: () => [], invalidate() {} }; });
    }
    source.resetHosts();
    bindPill();
    offer();
  });

  // The user's next message: failed runs they had a chance to see stop alerting.
  pi.on("input", (event) => {
    if ((event as { source?: string }).source === "interactive") source.seen();
  });

  pi.on("session_shutdown", async () => {
    inspectOff?.();
    inspectOff = undefined;
    disposeCharts();
    chartComponents.clear();
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
    headless.closeAll();
    await previousWatcher?.stop();
    for (let i = 0; i < lastStatus.length; i++) previousContext?.ui.setStatus(statusKey(i), undefined);
    previousContext?.ui.setStatus(LENS_STATUS_KEY, undefined);
    lastStatus = [];
    lastLensStatus = undefined;
    lensSeen.clear();
    ambiguous.clear();
    touchedAt.clear();
    prompts = 0;
    offering = busy = false;
  });

  pi.on("before_agent_start", async () => {
    turn = undefined;
    prompts++;
    if (!watcher) return;
    watcher.refresh();
    await watcher.settle(2000);
    const entries = stateEntries(true);
    const others = watcher.followed().filter((f) => !f.engaged && f.connection === "connected").map((f) => f.attachment.path);
    // Bring the running list up to date first: a cell may have started within the last render's debounce.
    if (ctxRef) bg.external(watcher.followed(), ctxRef.cwd);
    const note = others.length ? `Other marimo notebooks open under this directory, not used in this session (work in one through marimo-pair to follow it): ${others.join(", ")}` : "";
    const text = entries.length ? withWaitHint(snapshot(entries, { refresh: "prompt" }), bg.runningIds(), pi) : "";
    turn = text || note ? { text: [text, note].filter(Boolean).join("\n") } : undefined;
  });

  // The notebook this session's agent works in (through marimo-pair) becomes current for this
  // session, whatever other sessions or the browser do. Nested calls (codemode) arrive here too.
  // A call that could mean several followed notebooks counts for none: say so on the result of the
  // top-level call (a codemode script's, for its nested calls), naming the flags for each.
  pi.on("tool_call", async (event) => {
    const targets = pairTargets(JSON.stringify(event.input ?? {}));
    if (!targets.length || !watcher) return undefined;
    // A marimo-pair call at a server whose notebook is open in no browser: open it here first (no browser needed).
    const unopened = waitingFor(targets);
    if (unopened.length) await Promise.allSettled(unopened.map((w) => attachWaiting(w)));
    if (!watcher) return undefined;
    const before = watcher.engaged().length;
    watcher.touch(targets);
    if (watcher.engaged().length !== before) pi.appendEntry(ENTRY, { engaged: watcher.engaged() });
    for (const path of watcher.targeted(targets)) touchedAt.set(path, prompts);
    const candidates = targets.map((t) => watcher!.ambiguous(t)).find((c) => c.length);
    if (candidates) {
      const root = String((event as { toolCallId?: unknown }).toolCallId ?? "").split("/")[0]!;
      if (root) ambiguous.set(root, ambiguityNote(candidates));
    }
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.toolCallId.includes("/")) return undefined;
    const note = ambiguous.get(event.toolCallId);
    if (!note) return undefined;
    ambiguous.delete(event.toolCallId);
    return { content: [...event.content, { type: "text" as const, text: note }], ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}) };
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

  pi.registerEntryRenderer<ChartEntry>(CHART_ENTRY, (entry, _options, theme) => {
    if (!entry.data) return undefined;
    const known = chartComponents.get(entry.id);
    if (known) return known;
    const chart = new ChatChart(entry.data, theme, () => tuiRef?.requestRender());
    chartComponents.set(entry.id, chart);
    return chart;
  });

  pi.registerTool({
    name: "marimo_chart",
    label: "Chart",
    description: "Show a chart from a followed marimo notebook in the chat transcript, where the user sees it inline: Plotly figures run live (hover, zoom, pan, from the mouse or with /marimo inspect), other figures as pictures. Use it whenever you would show the user a notebook chart. Give the cell by name or id; the notebook only when several are followed.",
    promptSnippet: "Show a notebook chart inline in the transcript",
    parameters: Type.Object({
      cell: Type.String({ description: "The cell whose output is the chart: its name or id" }),
      notebook: Type.Optional(Type.String({ description: "The notebook's file name or path, when several are followed" })),
    }),
    async execute(_id, params) {
      const entry = await chartEntry(params.cell, params.notebook);
      pi.appendEntry(CHART_ENTRY, entry);
      const how = entry.plotly ? "live (Plotly)" : entry.png ? "as a picture" : entry.note ?? "";
      return { content: [{ type: "text", text: `Showed ${entry.label} from ${basename(entry.path)} in the transcript ${how}.` }], details: { cell: entry.cell } };
    },
  });

  pi.registerCommand("marimo", {
    description: "Choose the marimo notebooks Pi follows (view, open, auto, off, show, lens, chart <cell>, inspect)",
    getArgumentCompletions: (prefix) =>
      ["view", "open", "auto", "off", "show", "lens", "chart", "inspect"].filter((a) => a.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (!watcher) return;
      const arg = args.trim();
      if (arg === "chart" || arg.startsWith("chart ")) {
        const ref = arg.slice(5).trim();
        if (!ref) { ctx.ui.notify("marimo: /marimo chart <cell name or id>", "info"); return; }
        try { pi.appendEntry(CHART_ENTRY, await chartEntry(ref)); } catch (e) { ctx.ui.notify(`marimo: ${e instanceof Error ? e.message : String(e)}`, "warning"); }
        return;
      }
      if (arg === "inspect") {
        if (!inspectLatest(ctx.ui)) ctx.ui.notify("marimo: no live chart in the transcript (/marimo chart <cell> shows one)", "info");
        return;
      }
      if (arg === "auto") { setMode({ kind: "auto" }); ctx.ui.notify("marimo: following every notebook open under this directory", "info"); return; }
      if (arg === "off") { setMode({ kind: "off" }); ctx.ui.notify("marimo: off", "info"); return; }
      if (arg === "view") {
        const path = source.busiest();
        if (!path) ctx.ui.notify("marimo: no notebook followed", "info");
        else await openView(path, ctx.ui);
        return;
      }
      if (arg === "open") {
        // The keyboard path to a footer item's click: open a notebook whose server waits in no browser.
        const waiting = watcher.waiting();
        if (!waiting.length) { ctx.ui.notify("marimo: no notebook is waiting to be opened", "info"); return; }
        const labels = waiting.map((w) => `${w.canonicalPath}  (${shortWhere(w.url)})`);
        const choice = waiting.length === 1 ? labels[0] : await ctx.ui.select("Open which notebook?", labels);
        const picked = choice === undefined ? undefined : waiting[labels.indexOf(choice)];
        if (!picked) return;
        openUrl(waitingUrl(picked));
        ctx.ui.notify(`marimo: opening ${basename(picked.path)}`, "info");
        return;
      }
      if (arg === "lens") {
        const parts = stateEntries().map((e) => ({ path: e.attachment.path, lines: lensLines(e.notebook) })).filter((p) => p.lines.length);
        ctx.ui.notify(parts.length ? parts.map((p) => [p.path, ...p.lines].join("\n")).join("\n\n") : "marimo: no Lens selections in the followed notebooks", "info");
        return;
      }
      if (arg === "show") {
        const entries = stateEntries();
        ctx.ui.notify(entries.length ? snapshot(entries, { refresh: "prompt" }) : statusLines().join("\n") || "marimo: no notebook attached", "info");
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
