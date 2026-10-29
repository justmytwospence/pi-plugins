// Plotly figures drawn as PNGs for the notebook view. One long-lived Python process (uv, plotly,
// kaleido) keeps a sandboxed headless Chrome warm, so a 2D figure takes tens of milliseconds and
// a WebGL one under a second after the first. The browser is Chrome for Testing, downloaded once
// into pi-marimo's own cache: never the Chrome you use, and the same on every machine. The process
// ends after a few idle minutes and starts again on demand.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ChartRenderer, type VegaRunner } from "./vega.js";

const SCRIPT = String.raw`
import sys, os, json, base64
import kaleido
dest = os.environ.get("PI_MARIMO_CHROME_DIR")
if not os.environ.get("BROWSER_PATH"):
    os.environ["BROWSER_PATH"] = str(kaleido.get_chrome_sync(path=dest))
kaleido.start_sync_server(silence_warnings=True)
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    try:
        png = kaleido.calc_fig_sync(req["fig"], opts=dict(format="png", width=req.get("width", 760), height=req.get("height", 460), scale=req.get("scale", 2)))
        out = {"id": req["id"], "png": base64.b64encode(png).decode()}
    except Exception as e:
        out = {"id": req["id"], "error": str(e).strip().split("\n")[-1][:300]}
    print(json.dumps(out), flush=True)
kaleido.stop_sync_server()
`;

const IDLE_MS = 5 * 60_000;
/** The first call may download the browser (about 150 MB), so it gets longer. */
const FIRST_MS = 180_000;
const CALL_MS = 30_000;

interface Pending {
  resolve(png: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PlotlyDaemonOptions {
  command?: string[];
  chromeDir?: string;
  idleMs?: number;
}

/** The warm renderer: requests go to the Python process one line at a time and come back by id. */
export class PlotlyDaemon {
  private child: ChildProcessWithoutNullStreams | undefined;
  private ready = false;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private readonly command: string[];
  private readonly chromeDir: string;
  private readonly idleMs: number;

  constructor(options: PlotlyDaemonOptions = {}) {
    this.command = options.command ?? ["uv", "run", "--quiet", "--with", "plotly", "--with", "kaleido", "python", "-u", "-c", SCRIPT];
    this.chromeDir = options.chromeDir ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-marimo", "chrome");
    this.idleMs = options.idleMs ?? IDLE_MS;
  }

  /** A runner for ChartRenderer: figure JSON in, base64 PNG out. */
  readonly run: VegaRunner = (spec) => this.render(spec);

  private start(): ChildProcessWithoutNullStreams {
    const [cmd, ...args] = this.command;
    const child = spawn(cmd!, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PI_MARIMO_CHROME_DIR: this.chromeDir } });
    this.child = child;
    this.ready = false;
    this.buffer = "";
    let err = "";
    child.stderr.on("data", (d: Buffer) => { if (err.length < 2_000) err += d.toString(); });
    child.stdout.on("data", (d: Buffer) => this.onData(d.toString()));
    child.stdin.on("error", () => undefined);
    child.on("error", (e) => this.fail(child, e));
    child.on("close", (code) => this.fail(child, new Error(err.trim().split("\n").at(-1) || `exited ${code}`)));
    return child;
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.ready = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      let msg: { ready?: boolean; id?: number; png?: string; error?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { this.ready = true; continue; }
      const p = msg.id === undefined ? undefined : this.pending.get(msg.id);
      if (!p || msg.id === undefined) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.png) p.resolve(msg.png);
      else p.reject(new Error(msg.error ?? "no image"));
    }
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), this.idleMs);
    this.idle.unref?.();
  }

  render(figure: string): Promise<string> {
    let fig: unknown;
    try { fig = JSON.parse(figure); } catch { return Promise.reject(new Error("not a plotly figure")); }
    return new Promise((resolve, reject) => {
      const first = !this.child || !this.ready;
      const child = this.child ?? this.start();
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("timed out"));
      }, first ? FIRST_MS : CALL_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, fig })}\n`);
      this.touch();
    });
  }

  /** Ends the process (and with it the browser). */
  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    setTimeout(() => child.kill("SIGKILL"), 2_000).unref?.();
  }
}

let shared: (ChartRenderer & { daemon: PlotlyDaemon }) | undefined;

/** The one renderer every view uses, created on first need; its browser ends with Pi. */
export function sharedPlotly(): ChartRenderer & { daemon: PlotlyDaemon } {
  if (!shared) {
    const daemon = new PlotlyDaemon();
    shared = Object.assign(new ChartRenderer(daemon.run), { daemon });
    process.once("exit", () => daemon.stop());
  }
  return shared;
}
