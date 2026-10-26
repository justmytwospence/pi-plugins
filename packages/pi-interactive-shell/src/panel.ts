import { constants } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { encodeInput } from "./input.ts";
import { TerminalScreen } from "./screen.ts";
import { type PtyFactory, type PtyProcess, spawnPty, stopPty } from "./pty.ts";

export interface HandoffResult { output: string; exitCode: number; cancelled: boolean; truncated: false }
export function failure(message: string): HandoffResult {
  return { output: `(interactive command: ${message})`, exitCode: 1, cancelled: false, truncated: false };
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
    private readonly done: (result: HandoffResult) => void, private readonly spawn: PtyFactory = spawnPty) {
    this.width = Math.max(5, (tui.terminal?.columns ?? 80) - 2);
    const { cols, rows } = this.dimensions(this.width);
    this.screen = new TerminalScreen(cols, rows, () => { if (!this.closed) tui.requestRender(); }, data => {
      if (!this.closed && !this.ended) this.send(data);
    });
  }

  overlayOptions() {
    return { anchor: "bottom-center" as const, width: "100%" as const, maxHeight: "100%" as const, margin: this.expanded ? 0 : 1 };
  }

  private dimensions(width: number) {
    const height = Math.max(5, (this.tui.terminal?.rows ?? 24) - (this.expanded ? 0 : 2));
    const panelHeight = this.expanded ? height : Math.max(5, Math.floor(height * 0.55));
    return { cols: Math.max(1, width - 4), rows: Math.max(1, panelHeight - 4) };
  }

  start(): Promise<void> {
    return this.startPromise ??= this.startImpl();
  }

  private async startImpl() {
    try {
      const pty = await this.spawn(this.command, this.cwd, this.screen.terminal.cols, this.screen.terminal.rows);
      this.pty = pty;
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
      this.tui.requestRender();
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
    if (!this.closed) this.tui.requestRender();
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
    this.closed = true;
    this.queued = "";
    for (const listener of this.listeners.splice(0)) listener.dispose();
    this.screen.dispose();
    this.done(result);
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
      if (data === "f") this.expanded = !this.expanded;
      else if (data === "q") { if (this.ended) { void this.closeExited(); } else this.confirming = true; }
      else if (data === "u") this.offset = Math.min(this.screen.maxScrollback, this.offset + Math.max(1, Math.floor(this.screen.terminal.rows / 2)));
      else if (data === "d") this.offset = Math.max(0, this.offset - Math.max(1, Math.floor(this.screen.terminal.rows / 2)));
      else if (data === "g") this.offset = this.screen.maxScrollback;
      else if (data === "G") this.offset = 0;
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
    const innerWidth = this.width - 2;
    const pad = (text: string) => { const s = truncateToWidth(text, innerWidth); return s + " ".repeat(Math.max(0, innerWidth - visibleWidth(s))); };
    const border = (text: string) => this.theme.fg("accent", text);
    const status = this.closing ? "stopping" : this.starting ? "starting" : this.ended ? `exited ${this.result?.exitCode ?? 1}` : "running";
    const title = ` Interactive terminal · ${status} `;
    const top = border("┌" + truncateToWidth(title, innerWidth) + "─".repeat(Math.max(0, innerWidth - visibleWidth(title))) + "┐");
    const displayCommand = this.command.replace(/[\x00-\x1f\x7f-\x9f]/g, char => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
    const command = border("│") + pad(` $ ${displayCommand}`) + border("│");
    const lines = this.screen.render(this.offset, this.focused && !this.confirming && !this.prefix && !this.ended).map(line => border("│") + " " + line + " " + border("│"));
    const hint = this.confirming ? " Stop command? Enter stop · Esc return" : this.prefix ? " f size · q stop/close · u/d scroll · g/G top/end · Ctrl+] send" : this.ended ? " Enter/Esc close · Ctrl+] panel controls" : " Keyboard → command · Ctrl+] panel controls";
    return [top, command, ...lines, border("│") + pad(hint) + border("│"), border("└" + "─".repeat(innerWidth) + "┘")];
  }

  invalidate() { /* Rendering derives current theme and emulator state; no cached lines. */ }
  dispose() { if (!this.closed) void this.shutdown(); }
}
