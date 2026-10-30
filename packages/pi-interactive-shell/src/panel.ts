import { constants } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { encodeInput } from "./input.ts";
import { footerRows } from "./footer.ts";
import { TerminalScreen } from "./screen.ts";
import { type PtyFactory, type PtyProcess, spawnPty, stopPty } from "./pty.ts";

export interface HandoffResult { output: string; exitCode: number; cancelled: boolean; truncated: false }
export function failure(message: string): HandoffResult {
  return { output: `(interactive command: ${message})`, exitCode: 1, cancelled: false, truncated: false };
}

/** One styled UI row, distinct from the PTY's retained output cells. */
export function omissionDivider(count: number, width: number, dim: (text: string) => string): string {
  width = Math.max(0, Math.floor(width) || 0);
  if (width === 0) return "";
  const full = ` ${count} ${count === 1 ? "row" : "rows"} omitted `;
  const short = ` ${count} omitted `;
  const tiny = `…${count}…`;
  const label = [full, short, tiny].find(value => visibleWidth(value) <= width) ?? truncateToWidth(tiny, width, "", true);
  const remaining = width - visibleWidth(label);
  return dim("─".repeat(Math.floor(remaining / 2)) + label + "─".repeat(Math.ceil(remaining / 2)));
}

const INPUT_CONTEXT = Symbol.for("pi-plugins.input-context.v1");

export class TerminalPanel {
  focused = true;
  readonly [INPUT_CONTEXT] = () => "terminal";
  private readonly screen: TerminalScreen;
  private pty?: PtyProcess;
  private listeners: Array<{ dispose(): void }> = [];
  private expanded = false;
  private prefix = false;
  private confirming = false;
  private closing = false;
  private closed = false;
  private ended = false;
  private starting = true;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private result?: HandoffResult;
  private offset = 0;
  private width = 80;
  private queued = "";
  private outstanding = 0;
  private paused = false;

  constructor(private readonly tui: TUI, private readonly theme: Theme,
    readonly command: string, private readonly cwd: string,
    private readonly done: (result: HandoffResult, snapshot?: Component) => void, private readonly spawn: PtyFactory = spawnPty,
    private readonly autoClose = false, private readonly inline = false,
    private readonly onStarted?: () => void) {
    this.width = Math.max(5, (tui.terminal?.columns ?? 80) - 2);
    const { cols, rows } = this.dimensions(this.width);
    this.screen = new TerminalScreen(cols, rows, () => { if (!this.closed) tui.requestRender(); }, data => {
      if (!this.closed && !this.ended) this.send(data);
    });
  }

  private bounds() {
    const rows = Math.max(1, this.tui.terminal?.rows ?? 24);
    const footer = Math.min(Math.max(0, footerRows(this.tui)), Math.max(0, rows - 1));
    const gap = !this.expanded && rows - footer >= 7 ? 1 : 0;
    return { height: Math.max(1, rows - footer - gap * 2), margin: { top: gap, bottom: footer + gap, left: this.expanded ? 0 : 1, right: this.expanded ? 0 : 1 } };
  }

  overlayOptions() {
    const { height, margin } = this.bounds();
    return { anchor: "bottom-center" as const, width: "100%" as const, maxHeight: height, margin };
  }

  private dimensions(width: number) {
    if (this.inline) {
      const height = this.inlineHeight();
      return { cols: Math.max(1, width - 4), rows: Math.max(1, height - 4) };
    }
    const height = this.bounds().height;
    const panelHeight = this.expanded ? height : Math.min(height, Math.max(5, Math.floor(height * 0.55)));
    return { cols: Math.max(1, width - 4), rows: Math.max(1, panelHeight - 4) };
  }

  private inlineHeight() {
    const rows = Math.max(1, this.tui.terminal?.rows ?? 24);
    return this.expanded ? rows : Math.max(1, Math.floor(rows / 2));
  }

  start(): Promise<void> {
    if (this.closed || this.closing) return Promise.resolve();
    return this.startPromise ??= this.startImpl();
  }

  private async startImpl() {
    try {
      const pty = await this.spawn(this.command, this.cwd, this.screen.terminal.cols, this.screen.terminal.rows);
      this.pty = pty;
      this.onStarted?.();
      this.listeners.push(pty.onData(data => {
        if (this.closed) return;
        this.outstanding += data.length;
        this.screen.write(data);
        if (this.outstanding > 262_144 && !this.paused) { pty.pause(); this.paused = true; }
        void this.screen.flush().then(() => {
          this.outstanding -= data.length;
          if (this.paused && this.outstanding < 65_536 && !this.closed) { pty.resume(); this.paused = false; }
        });
      }));
      this.listeners.push(pty.onExit(event => { void this.exited(event.exitCode, event.signal); }));
      this.starting = false;
      this.resizePty(this.screen.terminal.cols, this.screen.terminal.rows);
      if (this.queued && !this.closing) this.send(this.queued);
      this.queued = "";
      this.tui.requestRender();
    } catch (error) {
      this.starting = false;
      this.ended = true;
      this.result = failure(error instanceof Error ? error.message : String(error));
      this.screen.write(this.result.output);
      if (this.autoClose || this.inline) {
        await this.screen.flush();
        await this.stop();
        this.finish(this.result);
      } else this.tui.requestRender();
    }
  }

  private async exited(code: number, signal = 0) {
    if (this.closed || this.ended) return;
    this.ended = true;
    const signalName = signal ? Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] ?? String(signal) : undefined;
    this.result = {
      output: signalName ? `(interactive command interrupted by ${signalName})` : `(interactive command exited with code ${code})`,
      exitCode: signal ? 128 + signal : code,
      cancelled: signal === constants.signals.SIGINT || signal === constants.signals.SIGTERM || code === 130,
      truncated: false,
    };
    await this.screen.flush();
    // Even a successful shell can leave descendants; this is not a detached job.
    await this.stop();
    if (this.autoClose || this.inline) this.finish(this.result);
    else if (!this.closed) this.tui.requestRender();
  }

  private stop() {
    return this.stopPromise ??= this.pty ? stopPty(this.pty) : Promise.resolve();
  }

  /** Called for explicit stop, reload, and disposal, never waits for user input. */
  shutdown(): Promise<void> {
    return this.shutdownPromise ??= (async () => {
      this.closing = true;
      await this.startPromise;
      await this.stop();
      await this.screen.flush();
      this.finish(this.result ?? { output: "(interactive command stopped)", exitCode: 130, cancelled: true, truncated: false });
    })();
  }

  private finish(result: HandoffResult) {
    if (this.closed) return;
    const snapshot = this.inline ? this.snapshot(result) : undefined;
    this.closed = true;
    this.queued = "";
    for (const listener of this.listeners.splice(0)) listener.dispose();
    this.screen.dispose();
    if (this.inline) this.done(result, snapshot);
    else this.done(result);
  }

  handleInput(data: string) {
    if (this.closed || this.closing) return;
    if (this.confirming) {
      if (matchesKey(data, "enter")) { this.confirming = false; void this.shutdown(); }
      else if (matchesKey(data, "escape")) this.confirming = false;
      this.tui.requestRender();
      return;
    }
    if (this.prefix) {
      this.prefix = false;
      if (matchesKey(data, "f")) this.expanded = !this.expanded;
      else if (matchesKey(data, "q")) { if (this.ended) { void this.closeExited(); } else this.confirming = true; }
      else if (matchesKey(data, "u")) this.offset = Math.min(this.screen.maxScrollback, this.offset + Math.max(1, Math.floor(this.screen.terminal.rows / 2)));
      else if (matchesKey(data, "d")) this.offset = Math.max(0, this.offset - Math.max(1, Math.floor(this.screen.terminal.rows / 2)));
      else if (matchesKey(data, "g")) this.offset = this.screen.maxScrollback;
      else if (matchesKey(data, "shift+g") || data === "G") this.offset = 0;
      else if (matchesKey(data, "ctrl+]")) this.send("\x1d");
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+]")) { this.prefix = true; this.tui.requestRender(); return; }
    if (this.ended) {
      if (matchesKey(data, "enter") || matchesKey(data, "escape")) void this.closeExited();
      return;
    }
    const input = encodeInput(data, this.screen.terminal.modes);
    if (input !== undefined) { this.offset = 0; this.send(input); }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.inline || this.closed || this.closing || this.ended || event.type !== "wheel" ||
      !Number.isFinite(event.wheelDelta) || !event.wheelDelta) return undefined;
    this.offset = Math.max(0, Math.min(this.screen.maxScrollback, Math.round(this.offset - event.wheelDelta)));
    this.tui.requestRender();
    return { handled: true, render: true };
  }

  private send(data: string) {
    if (this.ended) return;
    if (this.pty) {
      try { this.pty.write(data); } catch { /* Exit can race the next input packet. onExit owns status. */ }
    } else if (this.starting && this.queued.length + data.length <= 4096) this.queued += data;
  }

  private resizePty(cols: number, rows: number) {
    if (!this.ended) {
      try { this.pty?.resize(cols, rows); } catch { /* The native fd can close before onExit is delivered. */ }
    }
  }

  private async closeExited() {
    this.closing = true;
    await this.screen.flush();
    await this.stop();
    this.finish(this.result ?? failure("unknown exit status"));
  }

  render(width: number): string[] {
    this.width = Math.max(5, width);
    const { cols, rows } = this.dimensions(this.width);
    if (cols !== this.screen.terminal.cols || rows !== this.screen.terminal.rows) {
      this.screen.resize(cols, rows);
      this.resizePty(cols, rows);
    }
    this.offset = Math.min(this.offset, this.screen.maxScrollback);
    const content = this.screen.render(this.offset, this.focused && !this.confirming && !this.prefix && !this.ended);
    const status = this.closing ? "stopping" : this.starting ? "starting" : this.ended ? `exited ${this.result?.exitCode ?? 1}` : "running";
    const hint = this.confirming ? " Stop command? Enter stop · Esc return" : this.prefix ? " f size · q stop/close · u/d scroll · g/G top/end · Ctrl+] send" : this.ended ? " Enter/Esc close · Ctrl+] panel controls" : " Keyboard → command · Ctrl+] panel controls";
    return this.frame(content, status, hint).map(line => truncateToWidth(line, Math.max(0, width), "", true));
  }

  private snapshot(result: HandoffResult): Component {
    const { head, tail, omitted } = this.screen.headTail(this.screen.terminal.rows);
    const content = [...head, ...(omitted ? [""] : []), ...tail];
    const lines = this.frame(content, `exited ${result.exitCode}`, " Exited · output retained for this session", false);
    const dividerIndex = 2 + head.length;
    const capturedWidth = this.width;
    return {
      render: width => lines.map((line, index) => {
        if (omitted && index === dividerIndex) {
          const bodyWidth = Math.max(0, Math.min(capturedWidth, width) - 4);
          const border = this.theme.fg("accent", "│");
          line = border + " " + omissionDivider(omitted, bodyWidth, text => this.theme.fg("dim", text)) + " " + border;
        }
        return truncateToWidth(line, Math.max(0, width), "", true);
      }),
      invalidate() {},
    };
  }

  private frame(content: string[], status: string, hint: string, clipLive = true): string[] {
    const innerWidth = this.width - 2;
    const pad = (text: string) => { const s = truncateToWidth(text, innerWidth); return s + " ".repeat(Math.max(0, innerWidth - visibleWidth(s))); };
    const border = (text: string) => this.theme.fg("accent", text);
    const title = ` Interactive terminal · ${status} `;
    const top = border("┌" + truncateToWidth(title, innerWidth) + "─".repeat(Math.max(0, innerWidth - visibleWidth(title))) + "┐");
    const displayCommand = this.command.replace(/[\x00-\x1f\x7f-\x9f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
    const command = border("│") + pad(` $ ${displayCommand}`) + border("│");
    const lines = content.map(line => border("│") + " " + padContent(line) + " " + border("│"));
    function padContent(line: string) {
      const width = Math.max(1, innerWidth - 2);
      const text = truncateToWidth(line, width, "", true);
      return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
    }
    const frame = [top, command, ...lines, border("│") + pad(hint) + border("│"), border("└" + "─".repeat(innerWidth) + "┘")];
    return clipLive ? frame.slice(0, this.inline ? this.inlineHeight() : this.bounds().height) : frame;
  }

  invalidate() { /* Rendering derives current theme and emulator state; no cached lines. */ }
  dispose() { if (!this.closed) void this.shutdown(); }
}
